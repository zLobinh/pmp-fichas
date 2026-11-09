// Movement and the moves that take two turns, from the "Livro de Regras - Pokémon Mundo Perfeito":
//   - Deslocamento (pág. 50-52): walk/fly speed in meters, Disparada doubles it, half when
//     paralyzed/drowsy, 0 when incapacitated; standing up costs half.
//   - Voo (pág. 52): altitude per Pokémon, "Elevado" from 3 m, flying distance, falling when the fly
//     speed drops to 0, "Queda" damage (pág. 1835 of the text).
//   - Salto em Altura: a Pokémon on the ground can jump to reach a flying one in melee.
//   - Fly/Bounce/Dig/Dive/Phantom Force (invulnerable until the next turn), Focus Punch,
//     "carga" (charge now, release next turn) and "recarga" (no action/reaction next turn).
//
// State in sheet.battle: alt (meters), move { used, pos, dash, standUp }, prone, grounded,
// charging { move, turn, invuln, kind, from, focus }, prepared { move, targetIds }.
import { OBR, ID, SHEET_KEY, getSheet, updateSheet, pushLog, getSettings } from "./store.js?v=0.9.6";
import { d, fmtM } from "./rules.js?v=0.9.6";
import { conditionsOf, inInitiative, isActive, econOf, moveTiming, PRETTY, TurnError, guardedLoop, allies } from "./battle.js?v=0.9.6";
import { pointMeters, altitudeOf, checkRange, distanceMeters } from "./map.js?v=0.9.6";

const r1 = (n) => Math.round(n * 10) / 10;
const mod = (v) => Math.floor((v - 10) / 2);

// ------------------------------------------------------------------ two-turn moves

// semi-invulnerable phase: "usa 10 pés (3 metros) do seu deslocamento" (Phantom/Shadow Force don't)
export const SEMI = {
  Fly: { kind: "fly", cost: 3 },
  Bounce: { kind: "fly", cost: 3 },
  Dig: { kind: "dig", cost: 3 },
  Dive: { kind: "dive", cost: 3 },
  "Phantom Force": { kind: "ghost", cost: 0 },
  "Shadow Force": { kind: "ghost", cost: 0 },
};
// moves that still reach a Pokémon in that phase (from their texts). double: double damage dice;
// cancel: brings it back (Smack Down)
const BYPASS = {
  fly: { "Smack Down": { cancel: true }, Gust: { double: true }, Twister: { double: true }, Thunder: {}, Hurricane: {}, "Sky Uppercut": {} },
  dig: { Earthquake: { double: true }, Magnitude: { double: true }, Fissure: {} },
  dive: { Surf: {}, Whirlpool: {} },
  ghost: {},
};
const KIND_PT = { fly: "no alto", dig: "no subsolo", dive: "submerso", ghost: "fora de vista" };

// { kind: "invuln" | "focus" | "charge" | "recharge" } or null
export function special(rules, name) {
  if (SEMI[name]) return { kind: "invuln", semi: SEMI[name].kind, cost: SEMI[name].cost };
  if (name === "Focus Punch") return { kind: "focus" };
  const t = moveTiming(rules.moves[name] ?? {});
  if (t.charge) return { kind: "charge" };
  if (t.recharge) return { kind: "recharge" };
  return null;
}
export const chargingOf = (sheet) => sheet?.battle?.charging ?? null;
export const invulnOf = (sheet) => (sheet?.battle?.charging?.invuln ? sheet.battle.charging : null);
export const invulnText = (c) => `invulnerável, ${KIND_PT[c.kind] ?? ""} (${c.move})`;

// can this move reach the target? null = normal; { blocked, reason } or { hits, double, cancel }
export function invulnCheck(targetSheet, moveName) {
  const c = invulnOf(targetSheet);
  if (!c) return null;
  const by = BYPASS[c.kind]?.[moveName];
  if (by) return { hits: true, ...by, kind: c.kind, move: c.move };
  return { blocked: true, reason: invulnText(c) };
}

// is the charged move ready to be released now? (next turn; any time in free play)
export function releaseReady(sheet, running) {
  const c = chargingOf(sheet);
  if (!c) return false;
  return !running || (sheet.battle?.turns ?? 0) >= (c.readyAt ?? 0);
}

// "Elevado": at least 3 m up using its flight (pág. 52)
export const elevated = (item) => altitudeOf(item) >= 3;

// ------------------------------------------------------------------ movement

const INCAPACITATED = ["Asleep", "Frozen", "Stunned"];

async function combatRunning() {
  return (await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY]?.active === true)).length > 0;
}

// this turn's movement: { walk, fly, canFly, alt, base, budget, used, left, dash, tracking, why }
export function movement(rules, item) {
  const sheet = getSheet(item);
  const sp = rules.speeds(sheet.pkmn);
  const b = sheet.battle ?? {};
  const cond = conditionsOf(sheet);
  const alt = altitudeOf(item);
  const canFly = sp.fly > 0 && !b.grounded;
  // in the air it moves with the fly speed; on the ground, walking (or flying if it can't walk)
  let base = alt > 0 ? sp.fly : sp.walk || (canFly ? sp.fly : 0);
  let why = "";
  if (INCAPACITATED.some((k) => cond[k])) { base = 0; why = "incapacitado: deslocamento 0"; }
  else if (cond.Grappled) { base = 0; why = "agarrado: deslocamento 0"; }
  else if (b.thrown && alt > 0 && !sp.fly) { base = 0; why = "arremessado: no ar até o fim do próximo turno"; }
  else if (b.move?.stopped) { base = 0; why = "Sentinela: deslocamento 0 neste turno"; }
  else if (cond.Paralyzed || cond.Drowsy) {
    base = Math.floor(base / 2 / 1.5) * 1.5; // half, rounded down to 1,5 m
    why = cond.Paralyzed ? "paralisado: metade do deslocamento" : "sonolento: metade do deslocamento";
  }
  const mv = b.move ?? {};
  const budget = base * (mv.dash ? 2 : 1);
  // standing up costs half (only 1,5 m with "Atleta")
  const athlete = rules.hasFeat(sheet.pkmn, "Atleta (FOR)") || rules.hasFeat(sheet.pkmn, "Atleta (DES)");
  const used = r1((mv.used ?? 0) + (mv.standUp ? (athlete ? Math.min(1.5, base) : base / 2) : 0));
  return {
    walk: sp.walk, fly: sp.fly, swim: sp.swim, canFly, alt, base, budget, used,
    left: r1(Math.max(0, budget - used)), dash: !!mv.dash, tracking: inInitiative(item), why,
  };
}

// "Salto em Altura": 1 m + 0,5 m per STR mod point; half without a 3 m run before it.
// "Salto em Distância": 2 m + 1 m per STR mod point; half without the run.
export function jumps(rules, item) {
  const sheet = getSheet(item);
  const str = Math.max(0, mod(rules.attributes(sheet.pkmn).STR));
  // the run-up is 3 m (1,5 m with "Atleta")
  const athlete = rules.hasFeat(sheet.pkmn, "Atleta (FOR)") || rules.hasFeat(sheet.pkmn, "Atleta (DES)");
  const ran = (sheet.battle?.move?.used ?? 0) >= (athlete ? 1.5 : 3);
  const k = ran ? 1 : 0.5;
  return { high: r1((1 + 0.5 * str) * k), long: r1((2 + str) * k), ran, fullHigh: 1 + 0.5 * str, str };
}

// the jump a melee attacker can make right now ({ height, left }), or null when it can't
export async function jumpOpts(rules, item) {
  const sheet = getSheet(item);
  if (!sheet || altitudeOf(item) > 0) return null;
  const running = inInitiative(item) && (await combatRunning());
  const mv = movement(rules, item);
  return { height: jumps(rules, item).high, left: running ? mv.left : null };
}

// moves the token and pays for it in ONE update (the movement watcher sees it already paid)
export async function moveToken(itemId, pos, cost = 0) {
  await updateSheet(itemId, (s, dr) => {
    dr.position = { x: pos.x, y: pos.y };
    s.battle.move = { used: 0, ...(s.battle.move ?? {}), pos: { x: pos.x, y: pos.y } };
    s.battle.move.used = r1((s.battle.move.used ?? 0) + cost);
  });
}

// pays movement without moving (jumps, flying up/down, the 3 m of Fly/Dig...)
export async function spendMovement(itemId, meters) {
  await updateSheet(itemId, (s) => {
    s.battle.move ??= { used: 0 };
    s.battle.move.used = r1((s.battle.move.used ?? 0) + meters);
  });
}

// checks used by the quick sheet buttons: only on its own turn while combat is running
async function ownTurnCheck(item) {
  const running = inInitiative(item) && (await combatRunning());
  if (running && !isActive(item)) throw new TurnError("Não é o turno deste Pokémon.", "offturn");
  return running;
}

// "Disparada" (pág. 48): spends the action, extra movement equal to its speed
export async function dash(rules, item) {
  const running = await ownTurnCheck(item);
  if (!running) throw new TurnError("Disparada só conta em combate (Pretty Sordid rodando).");
  if (!econOf(getSheet(item)).action) throw new TurnError("A ação deste turno já foi usada.", "used");
  if (getSheet(item).battle?.move?.dash) throw new TurnError("Já usou Disparada neste turno.");
  await updateSheet(item.id, (s) => {
    s.battle.econ = { ...econOf(s), action: false };
    s.battle.move = { used: 0, pos: { ...item.position }, ...(s.battle.move ?? {}), dash: true };
  });
  const mv = movement(rules, item);
  await pushLog({ kind: "note", attacker: item.name, text: `usou Disparada (ação): deslocamento ${fmtM(mv.budget * 2)} neste turno` });
}

// flies up (+) or down (−); in combat it costs the same meters of movement
export async function changeAltitude(rules, item, delta) {
  const mv = movement(rules, item);
  if (!mv.canFly) throw new Error(getSheet(item).battle?.grounded ? "Foi derrubado (Smack Down): não voa até poder se mover de novo." : "Este Pokémon não tem deslocamento de voo.");
  if (mv.base === 0 && delta > 0) throw new Error(mv.why || "Sem deslocamento de voo.");
  const running = await ownTurnCheck(item);
  const target = Math.max(0, r1(mv.alt + delta));
  const cost = Math.abs(target - mv.alt);
  if (!cost) return mv.alt;
  // going up: the fly speed is what counts once it leaves the ground
  const left = mv.alt === 0 && delta > 0 ? r1(Math.max(0, mv.fly * (mv.dash ? 2 : 1) - mv.used)) : mv.left;
  if (running && cost > left + 0.05) throw new TurnError(`Deslocamento insuficiente: precisa ${fmtM(cost)}, sobra ${fmtM(left)}.`);
  await updateSheet(item.id, (s) => {
    s.battle.alt = target;
    if (running) { s.battle.move ??= { used: 0 }; s.battle.move.used = r1((s.battle.move.used ?? 0) + cost); }
  });
  return target;
}

// "Queda": 1d6 at 3 m or more than its high jump (the larger), +1d6 per full 3 m beyond, max 20d6;
// it ends up prone
export function fallDice(rules, item, meters) {
  const thr = Math.max(3, jumps(rules, item).fullHigh);
  if (meters < thr) return 0;
  return Math.min(20, 1 + Math.floor((meters - thr) / 3));
}

export async function fall(rules, item, why) {
  const alt = altitudeOf(item);
  if (!alt) return null;
  const n = getSheet(item).pkmn.hp.current > 0 ? fallDice(rules, item, alt) : 0; // fainted: just lands
  const rolls = Array.from({ length: n }, () => d(6));
  const dmg = rolls.reduce((a, b) => a + b, 0);
  await updateSheet(item.id, (s) => {
    s.battle.alt = 0;
    if (n) s.battle.prone = true;
    if (dmg && s.pkmn.hp.current > 0) {
      const temp = s.pkmn.hp.temp ?? 0, fromTemp = Math.min(temp, dmg);
      s.pkmn.hp.temp = temp - fromTemp;
      s.pkmn.hp.current = Math.max(0, s.pkmn.hp.current - (dmg - fromTemp));
    }
  });
  const text = `caiu de ${fmtM(alt)} (${why})${n ? `: ${n}d6 = ${dmg} de dano e ficou caído` : ", sem dano"}`;
  await pushLog({ kind: "note", attacker: item.name, text });
  return { dmg, n, text };
}

// a free spot closest to `from` where the move reaches the target. Walks the cells on the line
// from the attacker to the target and takes the first one in range (or a free neighbor of it).
// -> { pos, cost, jump } or null
export async function approach(rules, attacker, target, move, { maxCost = Infinity } = {}) {
  const dpi = await OBR.scene.grid.getDpi();
  const from = attacker.position;
  const others = (await OBR.scene.items.getItems((i) => (i.layer === "CHARACTER" || i.layer === "MOUNT") && i.id !== attacker.id && i.visible !== false))
    .map((i) => i.position);
  const free = (p) => !others.some((o) => Math.abs(o.x - p.x) < dpi * 0.5 && Math.abs(o.y - p.y) < dpi * 0.5);
  const dx = target.position.x - from.x, dy = target.position.y - from.y;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / dpi);
  const snap = (x, y) => ({ x: from.x + Math.round((x - from.x) / dpi) * dpi, y: from.y + Math.round((y - from.y) / dpi) * dpi });
  const sheet = getSheet(attacker);
  const tries = async (p) => {
    const cost = await pointMeters(from, p);
    if (cost > maxCost + 0.05) return null;
    const virt = { ...attacker, position: p };
    const jump = altitudeOf(attacker) === 0 && sheet ? { height: jumps(rules, virt).high, left: maxCost === Infinity ? null : maxCost - cost } : null;
    const [res] = await checkRange(virt, move, [target], { jump });
    return res.ok ? { pos: p, cost: r1(cost), jump: res.jump } : null;
  };
  for (let i = 0; i <= steps; i++) {
    const p = snap(from.x + (dx * i) / Math.max(1, steps), from.y + (dy * i) / Math.max(1, steps));
    if (Math.abs(p.x - target.position.x) < dpi * 0.5 && Math.abs(p.y - target.position.y) < dpi * 0.5) break; // reached the target's own cell
    if (free(p) || i === 0) {
      const ok = await tries(p);
      if (ok) return ok;
      continue;
    }
    // occupied: the free neighbors of that cell
    let best = null;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const q = { x: p.x + ox * dpi, y: p.y + oy * dpi };
      if (!free(q)) continue;
      const ok = await tries(q);
      if (ok && (!best || ok.cost < best.cost)) best = ok;
    }
    if (best) return best;
  }
  return null;
}

// ------------------------------------------------------------------ ataques de oportunidade (pág. 54)

// melee damaging "1 ação" moves it can use for an attack of opportunity (Struggle when none)
export function oaMoves(rules, pkmn) {
  const list = Object.keys(pkmn.moves ?? {}).filter((n) => {
    const m = rules.moveData(pkmn, n);
    const t = moveTiming(rules.moves[n] ?? {});
    return m.rangeInfo?.kind === "melee" && m.damage && t.action && !(typeof m.pp === "number" && m.pp <= 0);
  });
  return list.length ? list : ["Struggle"];
}

// the reactor's owner gets the choice (battle.oa), shown on its quick sheet
export async function offerOpportunity(reactor, target, why, { sentinel = false, back = null } = {}) {
  await updateSheet(reactor.id, (s) => {
    s.battle.oa = { targetId: target.id, targetName: target.name, at: Date.now(), why, sentinel, ...(back ? { back } : {}) };
  });
  await pushLog({ kind: "note", attacker: reactor.name, text: `⚔ pode fazer um ataque de oportunidade em ${target.name} (${why})` });
}

const canReact = (sheet) => {
  const c = conditionsOf(sheet);
  return sheet.pkmn.hp.current > 0 && !INCAPACITATED.some((k) => c[k]) && !c.Confused && econOf(sheet).reaction && !sheet.battle?.charging?.invuln;
};

// a creature moved from `from` to `to` by itself: who sees it leave their reach?
export async function checkOpportunity(rules, mover, from, to) {
  const ms = getSheet(mover);
  if (!ms) return [];
  // (also who came in by a switch and waits for the initiative: it has its reaction)
  const others = await OBR.scene.items.getItems((i) => i.id !== mover.id && i.metadata?.[SHEET_KEY] && !i.metadata[SHEET_KEY].ball && (inInitiative(i) || i.metadata[SHEET_KEY].battle?.joinNextRound));
  const out = [];
  for (const h of others) {
    const hs = getSheet(h);
    if (allies(hs, ms) || hs.battle?.oa || hs.pkmn.hp.current <= 0) continue;
    const reach = rules.reach(hs.pkmn);
    const was = await distanceMeters(h, { ...mover, position: from });
    const now = await distanceMeters(h, { ...mover, position: to });
    if (!(was <= reach + 0.05 && now > reach + 0.05)) continue;
    // it left an enemy's reach: say in the log why there is no attack when there isn't one
    const sentinel = rules.hasFeat(hs.pkmn, "Sentinela");
    const none = (why) => pushLog({ kind: "note", attacker: h.name, text: `${mover.name} saiu do alcance, sem ataque de oportunidade: ${why}` });
    if (!canReact(hs)) { await none(!econOf(hs).reaction ? `${h.name} já usou a reação` : `${h.name} não pode reagir agora`); continue; }
    if (ms.battle?.move?.disengage && !sentinel) { await none(`${mover.name} usou Desengajar`); continue; }
    if (rules.hasFeat(ms.pkmn, "Mobilidade") && ms.battle?.move?.meleed?.includes(h.id)) { await none(`${mover.name} tem Mobilidade e atacou ${h.name} corpo a corpo neste turno`); continue; }
    // where it was when it left the reach: a Sentinela hit pulls it back there (the last point of the
    // path still in reach, on the grid)
    let back = { ...from };
    for (let i = 20; i >= 0; i--) {
      const p = await OBR.scene.grid.snapPosition({ x: from.x + ((to.x - from.x) * i) / 20, y: from.y + ((to.y - from.y) * i) / 20 });
      if ((await distanceMeters(h, { ...mover, position: p })) <= reach + 0.05) { back = p; break; }
    }
    await offerOpportunity(h, mover, "saiu do alcance", { back });
    out.push(h);
  }
  return out;
}

// "Sentinela": an enemy within 1,5 m attacked someone else (who doesn't have the feat)
export async function checkSentinel(rules, attacker, targets) {
  const as = getSheet(attacker);
  if (!as) return;
  const others = await OBR.scene.items.getItems((i) => i.id !== attacker.id && i.metadata?.[SHEET_KEY] && inInitiative(i));
  for (const h of others) {
    const hs = getSheet(h);
    if (!rules.hasFeat(hs.pkmn, "Sentinela") || (hs.team ?? "inimigos") === (as.team ?? "inimigos") || !canReact(hs)) continue;
    if (targets.some((t) => t.id === h.id || rules.hasFeat(getSheet(t)?.pkmn ?? {}, "Sentinela"))) continue;
    if ((await distanceMeters(h, attacker)) > 1.55) continue;
    await offerOpportunity(h, attacker, "atacou outro alvo perto do Sentinela", { sentinel: true });
  }
}

// "Desengajar" (pág. 49): an action; its movement doesn't provoke attacks of opportunity this turn
export async function disengage(rules, item) {
  const running = await ownTurnCheck(item);
  if (!running) throw new TurnError("Desengajar só conta em combate (Pretty Sordid rodando).");
  if (!econOf(getSheet(item)).action) throw new TurnError("A ação deste turno já foi usada.", "used");
  await updateSheet(item.id, (s) => {
    s.battle.econ = { ...econOf(s), action: false };
    s.battle.move = { used: 0, pos: { ...item.position }, ...(s.battle.move ?? {}), disengage: true };
  });
  await pushLog({ kind: "note", attacker: item.name, text: "usou Desengajar (ação): não provoca ataques de oportunidade neste turno" });
}

// ------------------------------------------------------------------ the GM's watcher

export const TOAST = `${ID}/toast`;
const toast = (text, owner) => OBR.broadcast.sendMessage(TOAST, { text, owner }, { destination: "ALL" }).catch(() => {});
const samePos = (a, b) => a && b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

// Pays the movement of the Pokémon in the initiative as they are dragged: on its turn the meters
// come out of what's left; too far, or out of its turn, the token goes back. Also makes fliers
// that can't fly anymore (asleep, frozen, stunned, fainted, Smack Down) fall.
export function watchMovement(rules) {
  const tick = async () => {
    {
      const settings = await getSettings();
      // (Pokémon in a pokéball don't move or fall)
      const all = await OBR.scene.items.getItems((i) => i.metadata?.[SHEET_KEY] != null && !i.metadata[SHEET_KEY].ball);
      const running = (await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY]?.active === true)).length > 0;
      for (const t of all) {
        const s = getSheet(t);
        const alt = altitudeOf(t);
        if (alt > 0) {
          const cond = conditionsOf(s);
          // (a creature thrown up by an ally stays up until the end of its next turn)
          const why = s.pkmn.hp.current <= 0 ? "desmaiou" : INCAPACITATED.find((k) => cond[k]) ? "não consegue mais voar"
            : s.battle?.grounded ? "derrubado" : rules.speeds(s.pkmn).fly <= 0 && !s.battle?.thrown ? "não voa" : null;
          if (why) { await fall(rules, t, why); continue; }
        }
        if (!inInitiative(t)) continue;
        const mv = s.battle?.move;
        if (!mv?.pos || !running || !settings.moveControl) {
          // not tracking: just remember where it is (in combat, leaving a reach still provokes)
          if (!samePos(mv?.pos, t.position)) {
            await updateSheet(t.id, (sh) => { sh.battle.move = { used: 0, ...(sh.battle.move ?? {}), pos: { ...t.position } }; });
            if (running && mv?.pos && isActive(t)) await checkOpportunity(rules, t, mv.pos, t.position);
          }
          continue;
        }
        if (samePos(mv.pos, t.position)) continue;
        const dist = r1(await pointMeters(mv.pos, t.position));
        const info = movement(rules, t);
        let problem = null;
        if (!isActive(t)) problem = `${t.name}: não é o turno dele`;
        else if (dist > info.left + 0.05) problem = `${t.name}: deslocamento insuficiente (tentou ${fmtM(dist)}, sobra ${fmtM(info.left)}${info.why ? `; ${info.why}` : ""})`;
        if (problem) {
          await OBR.scene.items.updateItems([t.id], (ds) => { for (const d0 of ds) d0.position = { ...mv.pos }; });
          toast(problem, s.owner);
        } else {
          await updateSheet(t.id, (sh) => {
            sh.battle.move = { ...(sh.battle.move ?? {}), used: r1((sh.battle.move?.used ?? 0) + dist), pos: { ...t.position } };
          });
          // leaving an enemy's reach provokes an attack of opportunity
          await checkOpportunity(rules, t, mv.pos, t.position);
        }
      }
    }
  };
  const schedule = guardedLoop("deslocamento", tick, { delay: 100 });
  OBR.scene.items.onChange(schedule);
  schedule();
}
