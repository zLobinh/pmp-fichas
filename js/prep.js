// "Preparar batalha": two or more trainers, a format (1v1, 2v2, 3v3 = Pokémon on the field per side),
// how many reserves each trainer may use, an arena marked on the map, and each side picking its
// starters without seeing the others'. When everyone is ready the battle starts by itself; between the
// GM's own trainers it can also be SIMULATED (an AI plays the turns) and ends with a summary.
//
// State in the scene metadata (PREP_KEY):
//   { id, by, status: "setup" | "running" | "done", configured, format, reserves, arena: {x1,y1,x2,y2}|null,
//     sim, trainers: { [trainerId]: { side, actives, ready, starters: [ids], used } }, result }
// Each trainer's controller only writes its own entry; the UI shows the others as "escolhendo"/"pronto".
import { OBR, ID, SHEET_KEY, getSheet, updateSheet, pushLog } from "./store.js?v=0.9.28";
import { PRETTY, isActive, passTurn, moveTiming, conditionsOf, moveEffects, CONDITIONS, TEAMS } from "./battle.js?v=0.9.28";
import * as MFX from "./movefx.js?v=0.9.28";
import { TRAINER, trainerOf, party, store, release, inBall, joinInitiativeNow, entryAbilities } from "./trainer.js?v=0.9.28";
import { startCombat } from "./qol.js?v=0.9.28";
import { distanceMeters, pointMeters } from "./map.js?v=0.9.28";
import { approach, moveToken, movement } from "./tactics.js?v=0.9.28";
import { useMove } from "./combat.js?v=0.9.28";
import { isAreaTurn, fieldNow, FIELD_MOVES, removeAreas, AREA_KEY } from "./field.js?v=0.9.28";

export const PREP_KEY = `${ID}/prep`;
export const ARENA_KEY = `${ID}/arena`;
const LAST_KEY = `${ID}/prepLast`;
const TURN_KEY = `${ID}/turn`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const getPrep = async () => (await OBR.scene.getMetadata())[PREP_KEY] ?? null;
export async function setPrep(fn) {
  const cur = await getPrep();
  const next = fn(cur ? JSON.parse(JSON.stringify(cur)) : null);
  await OBR.scene.setMetadata({ [PREP_KEY]: next ?? undefined });
  return next;
}
export const simRunning = (prep) => !!prep && prep.status === "running" && prep.sim;

// Pokémon on the field per trainer: the format split among the trainers of that side
// ("cada um pode colocar no máximo um ativo por vez" when there are several on a side)
export function activesFor(prep, trainerId) {
  const side = prep.trainers[trainerId]?.side;
  const n = Object.values(prep.trainers).filter((t) => t.side === side).length;
  return Math.max(1, Math.floor((prep.format ?? 1) / Math.max(1, n)));
}

// a new preparation (from the context menu). trainers: items
export async function newPrep(trainers) {
  const entries = {};
  for (const t of trainers) entries[t.id] = { side: trainerOf(t)?.team ?? "inimigos", ready: false, starters: [], used: 0 };
  // two trainers of the same team would be allies: put the second on the other side
  const sides = Object.values(entries).map((e) => e.side);
  if (trainers.length === 2 && sides[0] === sides[1]) entries[trainers[1].id].side = sides[0] === "jogadores" ? "inimigos" : "jogadores";
  // the last battle's rules come back (format, reserves; the simulation only when every trainer is the GM's:
  // a battle with players' trainers is played by the players)
  const last = (await OBR.scene.getMetadata())[LAST_KEY] ?? {};
  const allNpc = await allGM(trainers);
  return setPrep(() => ({
    id: crypto.randomUUID(), by: OBR.player.id, at: Date.now(), status: "setup", configured: false,
    format: last.format ?? 1, reserves: last.reserves ?? 2, arena: null, sim: allNpc && !!last.sim, trainers: entries, result: null,
  }));
}

export const inArena = (arena, p) => !arena || (p.x >= Math.min(arena.x1, arena.x2) && p.x <= Math.max(arena.x1, arena.x2) && p.y >= Math.min(arena.y1, arena.y2) && p.y <= Math.max(arena.y1, arena.y2));
const clampTo = (arena, p) => !arena ? p : { x: Math.min(Math.max(p.x, Math.min(arena.x1, arena.x2)), Math.max(arena.x1, arena.x2)), y: Math.min(Math.max(p.y, Math.min(arena.y1, arena.y2)), Math.max(arena.y1, arena.y2)) };

// a free square near a point, inside the arena
async function spotNear(base, arena, skip = []) {
  const dpi = await OBR.scene.grid.getDpi();
  const others = (await OBR.scene.items.getItems((i) => i.layer === "CHARACTER" && i.visible !== false && !skip.includes(i.id))).map((i) => i.position);
  const free = (p) => inArena(arena, p) && !others.some((o) => Math.abs(o.x - p.x) < dpi * 0.5 && Math.abs(o.y - p.y) < dpi * 0.5);
  const c = clampTo(arena, base);
  for (let r = 0; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const p = await OBR.scene.grid.snapPosition({ x: c.x + dx * dpi, y: c.y + dy * dpi }).catch(() => ({ x: c.x + dx * dpi, y: c.y + dy * dpi }));
      if (free(p)) return p;
    }
  }
  return c;
}

// ------------------------------------------------------------------ the start
// everyone ready: the starters come out (inside the arena, next to their trainer), the others go back
// to the ball, initiative for all of them, round 1. Run by the GM's browser only.
export async function startPrepared(rules) {
  let prep = await getPrep();
  if (!prep || prep.status !== "setup" || !prep.configured) return false;
  if (!Object.values(prep.trainers).every((t) => t.ready && t.starters.length)) return false;
  // "starting" while the starters come out: the simulation (and its reserves) waits for "running",
  // otherwise it sent reserves and marked them "came in this round" in the middle of the start
  // a player's trainer in it: never simulated (the players play their own turns)
  const simOK = prep.sim && await allGM(await OBR.scene.items.getItems(Object.keys(prep.trainers)));
  prep = await setPrep((p) => ({ ...p, sim: simOK, status: "starting", startedAt: Date.now() }));
  const starters = [];
  for (const [tid, t] of Object.entries(prep.trainers)) {
    const [trainer] = await OBR.scene.items.getItems([tid]);
    if (!trainer) continue;
    for (const p of await party(tid)) {
      const s = getSheet(p);
      if (!inBall(s) && !t.starters.includes(p.id)) await store(rules, p, trainer, { quiet: true });
    }
    // the chosen starters, and (if one of them is gone or can't come out) the next healthy ones, up to
    // the number this trainer puts on the field (2v2 with one trainer per side: 2 each)
    const limit = activesFor(prep, tid);
    const healthy = (await party(tid)).filter((p) => getSheet(p).pkmn.hp.current > 0);
    const queue = [...t.starters, ...healthy.map((p) => p.id).filter((id) => !t.starters.includes(id))];
    const out = [];
    for (const id of queue) {
      if (out.length >= limit) break;
      const [p] = await OBR.scene.items.getItems([id]);
      if (!p || getSheet(p).pkmn.hp.current <= 0) continue;
      try {
        // where its side chose (📍 in the popup), or next to the trainer; a free square around that spot
        const pos = await spotNear(t.spots?.[p.id] ?? trainer.position, prep.arena, [p.id]);
        if (inBall(getSheet(p))) await release(rules, p, trainer, { pos, quiet: true });
        else await OBR.scene.items.updateItems([p.id], (ds) => { for (const d0 of ds) d0.position = pos; });
        // the side chosen here is the team for the fight
        await updateSheet(p.id, (s) => { s.team = t.side; });
        const fresh = (await OBR.scene.items.getItems([p.id]))[0];
        starters.push(fresh);
        out.push(fresh.name);
      } catch (e) { await pushLog({ kind: "note", attacker: trainer.name, text: `não conseguiu mandar ${p.name}: ${e.message}` }); }
    }
    await pushLog({ kind: "note", attacker: trainer.name, text: `mandou ${out.join(" e ") || "ninguém"} (${limit} em campo)` });
  }
  await setPrep((p) => { for (const [tid, t] of Object.entries(p.trainers)) t.used = Math.max(t.starters.length, starters.filter((s) => getSheet(s).trainer === tid).length); return p; });
  await OBR.scene.setMetadata({ [LAST_KEY]: { format: prep.format, reserves: prep.reserves, sim: !!prep.sim } });
  const names = Object.keys(prep.trainers).map((tid) => tid);
  const tNames = (await OBR.scene.items.getItems(names)).map((t) => t.name);
  await pushLog({ kind: "note", attacker: "Batalha", text: `começou: ${tNames.join(" × ")} (${prep.format}v${prep.format}, ${prep.reserves} reserva(s) cada)${prep.sim ? " — simulada" : ""}` });
  // a clean start: whatever was left of an older fight leaves the initiative (round 1, nobody "came in
  // this round" with an old round number), and the turn watcher starts over
  const old = await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY] != null && !i.metadata?.[`${ID}/areaMarker`]);
  if (old.length) await OBR.scene.items.updateItems(old.map((i) => i.id), (ds) => { for (const d0 of ds) delete d0.metadata[PRETTY]; });
  await OBR.scene.setMetadata({ [TURN_KEY]: undefined, "com.pretty-initiative/roundCount": 1 });
  for (const s of starters) await updateSheet(s.id, (x) => { if (x.battle) { delete x.battle.joinRound; delete x.battle.joinNextRound; delete x.battle.needsInitiative; } });
  aiMemo.clear();
  await startCombat(rules, starters);
  for (const s of starters) await entryAbilities(rules, (await OBR.scene.items.getItems([s.id]))[0]).catch(() => {});
  await setPrep((p) => (p ? { ...p, status: "running" } : p));
  return true;
}

// ------------------------------------------------------------------ during the fight
const sideOf = (prep, item) => prep.trainers[getSheet(item)?.trainer]?.side ?? null;
async function participants(prep) {
  const ids = Object.keys(prep.trainers);
  return OBR.scene.items.getItems((i) => ids.includes(i.metadata?.[SHEET_KEY]?.trainer));
}

// fainted ones go back, and a reserve comes in while the trainer may still use one
export async function sendReserves(rules, prep, notes = []) {
  for (const [tid, t] of Object.entries(prep.trainers)) {
    const [trainer] = await OBR.scene.items.getItems([tid]);
    if (!trainer) continue;
    const list = await party(tid);
    for (const p of list) if (!inBall(getSheet(p)) && getSheet(p).pkmn.hp.current <= 0) await store(rules, p, trainer, { quiet: true });
    const limit = activesFor(prep, tid);
    let out = (await party(tid)).filter((p) => !inBall(getSheet(p)) && getSheet(p).pkmn.hp.current > 0).length;
    while (out < limit && (t.used ?? 0) < limit + (prep.reserves ?? 0)) {
      const next = (await party(tid)).find((p) => inBall(getSheet(p)) && getSheet(p).pkmn.hp.current > 0);
      if (!next) break;
      const pos = await spotNear(trainer.position, prep.arena, [next.id]);
      await release(rules, next, trainer, { pos, quiet: true });
      await updateSheet(next.id, (s) => { s.team = t.side; });
      await joinInitiativeNow(rules, next);
      await entryAbilities(rules, (await OBR.scene.items.getItems([next.id]))[0]).catch(() => {});
      t.used = (t.used ?? 0) + 1;
      out++;
      // (the name on the token now: a Zoroark comes out under its Illusion)
      const shown = (await OBR.scene.items.getItems([next.id]))[0]?.name ?? next.name;
      notes.push(`${trainer.name} mandou ${shown}`);
      await pushLog({ kind: "note", attacker: trainer.name, text: `mandou ${shown}${t.used > limit ? ` (reserva ${t.used - limit} de ${prep.reserves})` : " (lugar vazio no campo)"}` });
    }
  }
  await setPrep((p) => { if (p) for (const [tid, t] of Object.entries(prep.trainers)) if (p.trainers[tid]) p.trainers[tid].used = t.used; return p; });
}

// the sides that can still fight (someone standing, or a reserve allowed and healthy)
export async function sidesLeft(prep) {
  const alive = new Set();
  for (const [tid, t] of Object.entries(prep.trainers)) {
    const list = await party(tid);
    const standing = list.some((p) => !inBall(getSheet(p)) && getSheet(p).pkmn.hp.current > 0);
    const canSend = (t.used ?? 0) < activesFor(prep, tid) + (prep.reserves ?? 0) && list.some((p) => inBall(getSheet(p)) && getSheet(p).pkmn.hp.current > 0);
    if (standing || canSend) alive.add(t.side);
  }
  return [...alive];
}

// ------------------------------------------------------------------ the AI (simulation)
// Every move the Pokémon has gets a score for this turn and the best one that works is used:
//  - damage on one enemy: expected damage (hit chance × type × strikes), a bonus when it can knock it
//    out or also leaves a condition, minus the walk to get there;
//  - area damage (cone, line, radius from the user): the enemies inside, minus the allies caught too;
//  - conditions (Thunder Wave, Will-O-Wisp, Toxic, Hypnosis...) on an enemy that has none and isn't immune;
//  - its own stages (Swords Dance, Calm Mind...) while they're low and it's healthy; stages down on an enemy;
//  - healing when it (or an ally, for Heal Pulse) is low;
//  - weather / terrain that help its own type, screens, Tailwind, hazards while the other side has reserves.
// Non-damaging moves aren't repeated by the same Pokémon within 4 rounds. A little randomness keeps it
// from always doing the same thing.
const REACTION_ONLY = (raw) => { const t = moveTiming(raw); return t.reaction && !t.action && !t.bonus; };
const MAJOR = ["Burning", "Frozen", "Paralyzed", "Poisoned", "BadlyPoisoned", "Drowsy", "Asleep"];
const STATUS_VALUE = { Asleep: 1.1, Frozen: 1.1, Paralyzed: 0.9, BadlyPoisoned: 0.9, Burning: 0.8, Stunned: 0.8, Drowsy: 0.7, Poisoned: 0.6, Confused: 0.6, Infatuated: 0.4 };
const STAGE_VALUE = { Attack: 0.35, SpecialAttack: 0.35, Defense: 0.22, SpecialDefense: 0.22, Speed: 0.15, Evasion: 0.25, Accuracy: 0.12, CritMargin: 0.2 };
const WEATHER_TYPES = { sun: ["Fire", "Grass"], rain: ["Water"], sand: ["Rock", "Ground", "Steel"], hail: ["Ice"], snow: ["Ice"] };
const TERRAIN_TYPES = { electric: ["Electric"], grassy: ["Grass"], psychic: ["Psychic"], misty: ["Fairy"] };
const aiMemo = new Map(); // itemId -> { move: round it was last used }
const jitter = () => 0.88 + Math.random() * 0.24;

const avgDamage = (md) => md.damage ? ((md.damage.amount * (md.damage.dice + 1)) / 2 + md.damage.bonus) * (md.damage.times || 1) * (md.hits || 1) : 0;
function hitChance(rules, md, target) {
  if (md.sureHit) return 1;
  if (md.attackBonus != null) return Math.min(0.95, Math.max(0.05, (21 - (rules.ac(getSheet(target).pkmn) - md.attackBonus)) / 20));
  if (md.saveDC != null) return 0.55;
  return 1;
}
const immuneTo = (rules, key, sheet) => (CONDITIONS[key]?.immune ?? []).some((t) => rules.types(sheet.pkmn).includes(t));
const hpRatio = (rules, sheet) => sheet.pkmn.hp.current / Math.max(1, rules.maxHP(sheet.pkmn));

// who an area move from the user would catch, aimed at `aim` (pixels; the area starts at the user)
async function areaCatch(me, md, aim, everyone, dpi) {
  const r = md.rangeInfo;
  const dir = aim ? Math.atan2(aim.position.y - me.position.y, aim.position.x - me.position.x) : 0;
  const out = [];
  for (const o of everyone) {
    if (o.id === me.id) continue;
    if ((await distanceMeters(me, o)) > r.meters + 0.05) continue;
    if (r.shape === "radius") { out.push(o); continue; }
    const dx = o.position.x - me.position.x, dy = o.position.y - me.position.y;
    const diff = Math.abs(((Math.atan2(dy, dx) - dir + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (r.shape === "cone" && diff <= 0.5) out.push(o);
    else if (r.shape === "semicircle" && diff <= Math.PI / 2) out.push(o);
    else if (r.shape === "line" && diff < Math.PI / 2 && Math.abs(Math.sin(diff)) * Math.hypot(dx, dy) <= dpi * 0.75) out.push(o);
  }
  return out;
}

export async function aiTurn(rules, item, prep) {
  const me = (await OBR.scene.items.getItems([item.id]))[0];
  const s = getSheet(me);
  if (!s || s.pkmn.hp.current <= 0) return null;
  const all = (await participants(prep)).filter((o) => !inBall(getSheet(o)) && getSheet(o).pkmn.hp.current > 0);
  const mySide = sideOf(prep, me);
  const enemies = all.filter((o) => sideOf(prep, o) !== mySide);
  const friends = all.filter((o) => sideOf(prep, o) === mySide);
  if (!enemies.length) return null;
  const round = Number((await OBR.scene.getMetadata())["com.pretty-initiative/roundCount"] ?? 1);
  const memo = aiMemo.get(me.id) ?? {};
  const fresh = (name) => memo[name] == null || round - memo[name] >= 4;
  const dpi = await OBR.scene.grid.getDpi();
  const field = await fieldNow(null, null, me).catch(() => ({}));
  const myTypes = rules.types(s.pkmn);
  const myRatio = hpRatio(rules, s);
  const dist = new Map();
  for (const o of all) if (o.id !== me.id) dist.set(o.id, await distanceMeters(me, o));
  const need = (md, o) => md.rangeInfo?.kind === "any" ? 0 : Math.max(0, dist.get(o.id) - (md.rangeInfo?.meters ?? 1.5));
  const enemyReserves = Object.entries(prep.trainers).some(([tid, t]) => t.side !== mySide && (t.used ?? 0) < activesFor(prep, tid) + (prep.reserves ?? 0));

  // the moves it can use now
  const moves = [];
  for (const name of Object.keys(s.pkmn.moves ?? {})) {
    const raw = rules.moves[name] ?? {};
    const md = rules.moveData(s.pkmn, name);
    if (md.missing || (typeof md.pp === "number" && md.pp <= 0) || REACTION_ONLY(raw) || !moveTiming(raw).action) continue;
    const mfx = MFX.special(name, raw);
    if (mfx.heal && !raw.atk && !raw.Save) md.damage = null;
    moves.push({ name, raw, md, fx: moveEffects(raw), mfx });
  }
  // what a plain attack is worth: the yardstick for the moves that don't deal damage
  let ref = 8;
  for (const m of moves) for (const e of enemies) if (m.md.damage && m.md.rangeInfo?.kind !== "area") ref = Math.max(ref, avgDamage(m.md) * rules.effectiveness(m.md.type, getSheet(e).pkmn) * hitChance(rules, m.md, e));

  // ---- the group fight (2v2, 3v3): who to go after
  //  threat: how hard each enemy hits our side (its best move against the one of us it hurts most);
  //  focus: the hurt ones first (finish before they act again), and the team sticks to the one an ally
  //  already went after this round or the last one (two hits on one beat one hit on each)
  const threat = new Map();
  for (const e of enemies) {
    const es = getSheet(e);
    let best = 0;
    for (const n of Object.keys(es.pkmn.moves ?? {})) {
      const md = rules.moveData(es.pkmn, n);
      if (!md.damage) continue;
      for (const f of friends) best = Math.max(best, avgDamage(md) * rules.effectiveness(md.type, getSheet(f).pkmn));
    }
    threat.set(e.id, best);
  }
  const maxThreat = Math.max(1, ...threat.values());
  const teamTarget = aiMemo.get(`side:${mySide}`);
  const group = enemies.length > 1 || friends.length > 1;
  const weight = (e) => {
    if (!group) return 1;
    let w = 0.8 + 0.5 * (threat.get(e.id) ?? 0) / maxThreat; // the dangerous ones
    w *= 1 + 0.5 * (1 - hpRatio(rules, getSheet(e)));          // the hurt ones
    if (teamTarget && teamTarget.id === e.id && round - teamTarget.round <= 1) w *= 1.2; // focus fire
    return w;
  };
  // how many of us (and of them) a weather / terrain / screen helps
  const typeCount = (list, types) => list.filter((o) => rules.types(getSheet(o).pkmn).some((t) => types.includes(t))).length;
  const nearMe = async (list, r) => { let n = 0; for (const o of list) if (o.id === me.id || (dist.get(o.id) ?? 99) <= r + 0.05) n++; return n; };

  const plans = [];
  const add = (p) => { if (p.score > 0) plans.push({ ...p, score: p.score * jitter() }); };
  for (const { name, raw, md, fx, mfx } of moves) {
    const kind = md.rangeInfo?.kind;
    const fm = FIELD_MOVES[name];
    // ---- weather, terrain, screens, hazards
    if (fm) {
      if (!fresh(name)) continue;
      let v = 0, expand = false;
      // weather / terrain: worth it when it helps more of us than of them
      const helps = (types) => typeCount(friends, types) - 0.7 * typeCount(enemies, types);
      if (fm.weather && field.weather !== fm.weather && (WEATHER_TYPES[fm.weather] ?? []).some((t) => myTypes.includes(t))) v = ref * 0.45 * Math.max(0, helps(WEATHER_TYPES[fm.weather]));
      else if (fm.terrain && field.terrain !== fm.terrain && (TERRAIN_TYPES[fm.terrain] ?? []).some((t) => myTypes.includes(t))) v = ref * 0.4 * Math.max(0, helps(TERRAIN_TYPES[fm.terrain]));
      // screens: only on itself (½) or widened to the allies inside (−⅓ each) when there are any;
      // Tailwind & co.: every ally inside counts
      else if (["reflect", "lightScreen", "auroraVeil"].includes(fm.side) && (!fm.needs || fm.needs.includes(field.weather))) {
        const inside = await nearMe(friends, fm.r ?? 4.5);
        expand = inside >= 2;
        v = ref * (fm.needs ? 0.6 : 0.45) * (expand ? 0.75 * inside : 1);
      }
      else if (fm.side && (!fm.needs || fm.needs.includes(field.weather))) v = ref * (fm.needs ? 0.6 : 0.45) * Math.max(1, 0.8 * await nearMe(friends, fm.r ?? 6));
      else if (fm.hazard && enemyReserves) v = ref * 0.4;
      if (!v) continue;
      const e = fm.at === "target" ? enemies[0] : null;
      add({ name, md, kind: "field", targets: e ? [e] : [], opts: { ignoreRange: true, expand }, need: 0, score: v });
      continue;
    }
    // ---- area damage
    if (kind === "area" && md.damage) {
      for (const aim of md.rangeInfo.shape === "radius" ? [null] : enemies) {
        const caught = await areaCatch(me, md, aim, all, dpi);
        let v = 0;
        for (const o of caught) {
          const dmg = avgDamage(md) * rules.effectiveness(md.type, getSheet(o).pkmn) * hitChance(rules, md, o);
          // an ally caught: bad; knocking an ally out: never worth it
          if (sideOf(prep, o) === mySide) v -= dmg * (getSheet(o).pkmn.hp.current <= dmg ? 4 : 1.5);
          else v += dmg * (getSheet(o).pkmn.hp.current <= dmg ? 1.3 : 1) * weight(o);
        }
        add({ name, md, kind: "area", targets: caught, opts: { area: true }, need: 0, score: v });
      }
      continue;
    }
    // ---- healing
    if (mfx.heal) {
      if (!fresh(name) && !mfx.heal.self) continue;
      const amount = mfx.heal.table ? rules.maxHP(s.pkmn) * 0.35 : (mfx.heal.amount ?? 2) * ((mfx.heal.sides ?? 6) + 1) / 2 + 3;
      if (mfx.heal.self || kind === "self") {
        if (myRatio < 0.5 && !(mfx.heal.rest && myRatio > 0.3)) add({ name, md, kind: "heal", targets: kind === "self" ? [] : [me], opts: {}, need: 0, score: Math.min(amount, rules.maxHP(s.pkmn) - s.pkmn.hp.current) * (1.7 - myRatio) });
      } else {
        for (const f of friends) {
          const r = hpRatio(rules, getSheet(f));
          if (f.id === me.id || r >= 0.5) continue;
          add({ name, md, kind: "heal", targets: [f], opts: {}, need: need(md, f), score: Math.min(amount, rules.maxHP(getSheet(f).pkmn) - getSheet(f).pkmn.hp.current) * (1.5 - r) - need(md, f) * 0.5 });
        }
      }
      continue;
    }
    // ---- its own stages (Swords Dance, Calm Mind, Dragon Dance...)
    if (!md.damage && fx.self?.length && kind === "self") {
      if (!fresh(name) || myRatio < 0.5 || (fx.hpCost && myRatio < 0.65)) continue;
      let v = 0;
      for (const st of fx.self) if (st.delta > 0 && (s.pkmn.stages?.[st.stat] ?? 0) < 3) v += ref * (STAGE_VALUE[st.stat] ?? 0.1) * Math.min(st.delta, 2);
      add({ name, md, kind: "buff", targets: [], opts: {}, need: 0, score: v });
      continue;
    }
    // ---- conditions and stages down on an enemy (no damage)
    const cond = !md.damage ? (fx.statusDirect ?? fx.contest?.status ?? fx.statusFail ?? null) : null;
    const drops = !md.damage ? [...(fx.direct ?? []), ...(fx.fail ?? []), ...(fx.contest?.stages ?? [])].filter((x) => x.delta < 0) : [];
    if (!md.damage && (cond || drops.length) && kind !== "self") {
      if (!fresh(name)) continue;
      const worth = (e) => {
        const es = getSheet(e);
        const p = fx.contest ? 0.6 : hitChance(rules, md, e);
        let v = 0;
        if (cond && !immuneTo(rules, cond, es) && !conditionsOf(es)[cond] && !(MAJOR.includes(cond) && Object.keys(conditionsOf(es)).some((k) => MAJOR.includes(k)))) {
          v += ref * (STATUS_VALUE[cond] ?? 0.5) * (hpRatio(rules, es) > 0.4 ? 1 : 0.4);
        }
        for (const d0 of drops) if ((es.pkmn.stages?.[d0.stat] ?? 0) > -3) v += ref * (STAGE_VALUE[d0.stat] ?? 0.1) * 0.8 * Math.min(-d0.delta, 2);
        // in a group fight, slowing / putting to sleep the one that hits hardest is what matters
        return v * p * (group ? 0.8 + 0.5 * (threat.get(e.id) ?? 0) / maxThreat : 1);
      };
      if (kind === "area") {
        // from where it stands: the enemies caught, minus the allies caught too
        for (const aim of md.rangeInfo.shape === "radius" ? [null] : enemies) {
          const caught = await areaCatch(me, md, aim, all, dpi);
          const v = caught.reduce((sum, o) => sum + (sideOf(prep, o) === mySide ? -worth(o) : worth(o)), 0);
          add({ name, md, kind: "status", targets: caught, opts: { area: true }, need: 0, score: v });
        }
        continue;
      }
      for (const e of enemies) add({ name, md, kind: "status", targets: [e], opts: {}, need: need(md, e), score: worth(e) - need(md, e) * 0.5 });
      continue;
    }
    // ---- damage on one enemy
    if (md.damage && kind !== "self" && kind !== "area") {
      for (const e of enemies) {
        const es = getSheet(e);
        const eff = rules.effectiveness(md.type, es.pkmn);
        if (eff === 0) continue;
        const dmg = avgDamage(md) * eff;
        let v = dmg * hitChance(rules, md, e);
        if (es.pkmn.hp.current <= dmg) v *= 1.4; // can knock it out
        const extra = fx.statusHit ?? fx.natural?.status;
        if (extra && !immuneTo(rules, extra, es) && !Object.keys(conditionsOf(es)).some((k) => MAJOR.includes(k))) v *= fx.statusHit ? 1.15 : 1.05;
        if (fx.self?.some((x) => x.delta < 0)) v *= 0.92; // Close Combat, Overheat...
        if (mfx.recoil) v *= 0.9;
        if (mfx.selfKO) v *= enemies.length === 1 && es.pkmn.hp.current <= dmg ? 1 : 0.2;
        add({ name, md, kind: "hit", targets: [e], opts: {}, need: need(md, e), score: v * weight(e) - need(md, e) * 0.5 });
      }
    }
  }
  plans.sort((a, b) => b.score - a.score);
  if (!plans.length) plans.push(...enemies.map((e) => ({ name: "Struggle", md: rules.moveData(s.pkmn, "Struggle"), kind: "hit", targets: [e], opts: {}, need: need({ rangeInfo: { meters: 1.5 } }, e), score: 0 })));
  const left = movement(rules, me).left;
  const fails = [];
  for (const c of plans.slice(0, 12)) {
    let cur = (await OBR.scene.items.getItems([me.id]))[0];
    if (c.need > 0.05) {
      const spot = await approach(rules, cur, c.targets[0], c.md, { maxCost: left }).catch(() => null);
      if (!spot || !inArena(prep.arena, spot.pos)) continue;
      await moveToken(me.id, spot.pos, spot.cost);
      cur = (await OBR.scene.items.getItems([me.id]))[0];
    }
    try {
      const targets = c.targets.length ? await OBR.scene.items.getItems(c.targets.map((t) => t.id)) : [];
      const entry = await useMove(rules, cur, c.name, targets, c.opts);
      if (c.kind !== "hit" && c.kind !== "area") aiMemo.set(me.id, { ...memo, [c.name]: round });
      // the team's target for focus fire
      if (c.kind === "hit" && c.targets[0]) aiMemo.set(`side:${mySide}`, { id: c.targets[0].id, round });
      return { move: c.name, targets, entry };
    } catch (e) { fails.push(`${c.name}: ${e.message}`); } // out of range, no action, restricted: the next one
  }
  if (fails.length) await pushLog({ kind: "note", attacker: me.name, text: `não conseguiu usar um move (${[...new Set(fails)].slice(0, 2).join("; ")})` });
  // nobody in reach: walk towards the nearest enemy (inside the arena)
  // (in a group fight, towards the team's target when there is one)
  const near = (teamTarget && enemies.find((e) => e.id === teamTarget.id))
    ?? enemies.sort((a, b) => Math.hypot(a.position.x - me.position.x, a.position.y - me.position.y) - Math.hypot(b.position.x - me.position.x, b.position.y - me.position.y))[0];
  for (const f of [1, 0.75, 0.5, 0.25]) {
    const p = clampTo(prep.arena, { x: me.position.x + (near.position.x - me.position.x) * f, y: me.position.y + (near.position.y - me.position.y) * f });
    const cost = await pointMeters(me.position, p);
    if (cost <= left + 0.05 && cost > 0) { await moveToken(me.id, p, Math.round(cost * 10) / 10); break; }
  }
  return null;
}

// plays the whole fight on the GM's browser; ends with a summary (log + prep.result)
let simLock = false;
export async function runSim(rules) {
  if (simLock) return;
  simLock = true;
  const stats = { dealt: {}, kos: [], turns: 0, round: 1 };
  const stuck = { key: null, since: Date.now() };
  try {
    for (let guard = 0; guard < 600; guard++) {
      const prep = await getPrep();
      if (!simRunning(prep) || prep.stop) break;
      await sendReserves(rules, prep);
      const sides = await sidesLeft(prep);
      if (sides.length <= 1) { await finish(rules, prep, sides[0] ?? null, stats); break; }
      const items = await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY] != null);
      const active = items.find(isActive);
      const meta = await OBR.scene.getMetadata();
      stats.round = Number(meta["com.pretty-initiative/roundCount"] ?? stats.round);
      // the GM's watcher runs the start of each turn first (conditions, weather...); if it doesn't
      // get to it in 15 s, the simulation passes that turn itself instead of waiting forever
      const waitKey = `${active?.id}:${stats.round}`;
      if (waitKey !== stuck.key) Object.assign(stuck, { key: waitKey, since: Date.now() });
      const waiting = !active || meta[TURN_KEY]?.activeId !== active.id || !meta[TURN_KEY]?.done || isAreaTurn(active)
        || (getSheet(active)?.battle?.joinRound != null && stats.round === getSheet(active).battle.joinRound - 1);
      if (waiting) {
        if (active && Date.now() - stuck.since > 15000) { await passTurn(active.id).catch(() => {}); stuck.since = Date.now(); }
        await wait(300);
        continue;
      }
      const s = getSheet(active);
      const ids = Object.keys(prep.trainers);
      if (!s || !ids.includes(s.trainer)) { await passTurn(active.id); await wait(400); continue; }
      // who loses how much on this turn
      const before = new Map((await participants(prep)).map((p) => [p.id, getSheet(p).pkmn.hp.current]));
      await aiTurn(rules, active, prep).catch(() => null);
      const after = await participants(prep);
      for (const p of after) {
        const b = before.get(p.id);
        const now = getSheet(p).pkmn.hp.current;
        if (b == null || sideOf(prep, p) === sideOf(prep, active)) continue;
        if (now < b) stats.dealt[active.name] = (stats.dealt[active.name] ?? 0) + (b - now);
        if (b > 0 && now <= 0) stats.kos.push({ by: active.name, ko: p.name, round: stats.round });
      }
      stats.turns++;
      await wait(700);
      const still = (await OBR.scene.items.getItems([active.id]))[0];
      if (still && isActive(still)) await passTurn(active.id);
      await wait(500);
    }
  } finally { simLock = false; }
}

async function finish(rules, prep, winnerSide, stats) {
  const trainers = await OBR.scene.items.getItems(Object.keys(prep.trainers));
  const bySide = (side) => trainers.filter((t) => prep.trainers[t.id].side === side).map((t) => t.name);
  const lines = [];
  lines.push(winnerSide ? `🏆 Vencedor: ${bySide(winnerSide).join(" e ")} (${TEAMS[winnerSide] ?? winnerSide})` : "Empate: ninguém ficou de pé");
  lines.push(`${stats.round} rodada(s), ${stats.turns} turno(s) jogados`);
  for (const k of stats.kos) lines.push(`💥 ${k.by} derrubou ${k.ko} (rodada ${k.round})`);
  const best = Object.entries(stats.dealt).sort((a, b) => b[1] - a[1])[0];
  if (best) lines.push(`⭐ Mais dano: ${best[0]} (${best[1]})`);
  for (const t of trainers) {
    const team = await party(t.id);
    const up = team.filter((p) => getSheet(p).pkmn.hp.current > 0);
    lines.push(`${t.name}: ${up.length}/${team.length} de pé${up.length ? ` — ${up.map((p) => `${p.name} ${getSheet(p).pkmn.hp.current}/${rules.maxHP(getSheet(p).pkmn)}`).join(", ")}` : ""}`);
  }
  await setPrep((p) => ({ ...p, status: "done", result: { winner: winnerSide, lines, at: Date.now() } }));
  // the fight is over: out of the initiative
  const inInit = await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY] != null && (Object.keys(prep.trainers).includes(i.metadata?.[SHEET_KEY]?.trainer)));
  await OBR.scene.items.updateItems(inInit.map((i) => i.id), (ds) => { for (const d0 of ds) delete d0.metadata[PRETTY]; });
  await pushLog({ kind: "note", attacker: "Batalha", text: lines.join(" · ") });
}

// a non-simulated prepared battle also gets its summary when one side is out
export async function checkEnd(rules) {
  const prep = await getPrep();
  if (!prep || prep.status !== "running" || prep.sim) return;
  const sides = await sidesLeft(prep);
  if (sides.length <= 1) await finish(rules, prep, sides[0] ?? null, { dealt: {}, kos: [], turns: 0, round: Number((await OBR.scene.getMetadata())["com.pretty-initiative/roundCount"] ?? 1) });
}

// ------------------------------------------------------------------ the arena on the map
// a rectangle (DRAWING layer) from two clicks; the AI and the starters stay inside it
export async function drawArena(a, b) {
  const old = await OBR.scene.items.getItems((i) => !!i.metadata?.[ARENA_KEY]);
  if (old.length) await OBR.scene.items.deleteItems(old.map((i) => i.id));
  const { buildShape } = (await import("./store.js?v=0.9.28")).SDK;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
  const item = buildShape().shapeType("RECTANGLE").width(w).height(h).position({ x, y })
    .fillColor("#f59e0b").fillOpacity(0.06).strokeColor("#f59e0b").strokeOpacity(0.9).strokeWidth(6).strokeDash([30, 18])
    .layer("DRAWING").locked(true).disableHit(true).name("Arena da batalha").metadata({ [ARENA_KEY]: true }).build();
  await OBR.scene.items.addItems([item]);
  await setPrep((p) => (p ? { ...p, arena: { x1: x, y1: y, x2: x + w, y2: y + h } } : p));
}
export async function clearArena() {
  const old = await OBR.scene.items.getItems((i) => !!i.metadata?.[ARENA_KEY]);
  if (old.length) await OBR.scene.items.deleteItems(old.map((i) => i.id));
}

// "Encerrar e limpar": stops the simulation, takes the fighters out of the initiative and removes what
// the battle left on the map (the arena, weather/terrain/screen areas and their markers)
export async function endPrep() {
  const prep = await getPrep();
  if (prep?.status === "running") await setPrep((p) => (p ? { ...p, stop: true, sim: false } : p));
  const ids = Object.keys(prep?.trainers ?? {});
  const inInit = await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY] != null && ids.includes(i.metadata?.[SHEET_KEY]?.trainer));
  if (inInit.length) await OBR.scene.items.updateItems(inInit.map((i) => i.id), (ds) => { for (const d0 of ds) delete d0.metadata[PRETTY]; });
  const areas = await OBR.scene.items.getItems((i) => !!i.metadata?.[AREA_KEY]);
  await removeAreas(areas.map((a) => a.id)).catch(() => {});
  await clearArena();
  await OBR.scene.setMetadata({ [PREP_KEY]: undefined, [TURN_KEY]: undefined, "com.pmp-fichas/field": {} });
}

// is this trainer played by the GM? (its owner is the GM, or a player who isn't in the room)
export async function npcTrainer(trainer, gmId, players) {
  const owner = trainerOf(trainer)?.owner;
  return !owner || owner === gmId || !players.some((p) => p.id === owner);
}
// every one of these trainers is played by the GM (asked from the GM's browser)
export async function allGM(trainers) {
  const players = await OBR.party.getPlayers().catch(() => []);
  for (const t of trainers) if (!(await npcTrainer(t, OBR.player.id, players))) return false;
  return true;
}
export { TRAINER };
