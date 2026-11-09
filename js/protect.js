// Protect and the other defensive reactions (Detect, Spiky Shield, King's Shield, Baneful Bunker,
// Silk Trap, Burning Bulwark, Obstruct, Wide Guard, Quick Guard, Crafty Shield, Upper Hand, Endure).
//
// When a move is used against Pokémon of another team, before any die is rolled:
//   1. protections already up (until the start of the protector's next turn) block it right away;
//   2. Pokémon that could defend now (the move in their list, PP, reaction free, not incapacitated,
//      not already giving up their next action) are asked: the request goes into the protector's
//      sheet (battle.defenseAsk); the background of its owner (or of the GM) opens the defend.html
//      popup with a 5 s timer; the answer comes back in battle.defenseAnswer;
//   3. no answer in time = no defense.
// Defending costs the reaction, the action of the next turn and 1 PP. Used in a row (the round
// before), the book's rule: 1d6 per consecutive success (max 6d6), all of them 5 or 6.
import { OBR, SHEET_KEY, getSheet, updateSheet, pushLog } from "./store.js?v=0.9.6";
import { fmtM } from "./rules.js?v=0.9.6";
import { CONDITIONS, conditionsOf, econOf, inInitiative, allies, giveCondition, addStage, STAGES } from "./battle.js?v=0.9.6";
import { distanceMeters } from "./map.js?v=0.9.6";

// kind: what the protection covers
//   single       any single-target move aimed at the user
//   singleDamage only damaging single-target moves aimed at the user
//   wide         moves hitting several targets (areas), the user and allies within `radius`
//   quick        priority moves, the user and allies within `radius`
//   crafty       status moves, the user and allies within `radius`
//   upper        counterattack against a priority move (cancels it on a hit)
//   endure       a hit that would knock it out leaves 1 HP until its next turn
// contact: what happens to an attacker that hits it in melee while protected
export const DEFENSES = {
  Protect: { kind: "single", streak: true },
  Detect: { kind: "single", streak: true },
  "Spiky Shield": { kind: "single", streak: true, contact: { damageLevel: true } },
  "Baneful Bunker": { kind: "single", streak: true, contact: { status: "Poisoned" } },
  "Silk Trap": { kind: "single", streak: true, contact: { stages: [{ stat: "Speed", delta: -1 }] } },
  "Burning Bulwark": { kind: "single", streak: true, contact: { status: "Burning" } },
  "King's Shield": { kind: "singleDamage", streak: true, contact: { stages: [{ stat: "Attack", delta: -2 }] } },
  Obstruct: { kind: "singleDamage", streak: true, contact: { stages: [{ stat: "Defense", delta: -2 }] } },
  "Wide Guard": { kind: "wide", radius: 6, streak: true, guard: true },
  "Quick Guard": { kind: "quick", radius: 9, streak: true, guard: true },
  "Crafty Shield": { kind: "crafty", radius: 3 },
  "Upper Hand": { kind: "upper" },
  Endure: { kind: "endure", streak: true },
};
const KIND_PT = {
  single: "Moves de alvo único", singleDamage: "Moves danosos de alvo único", wide: "Moves em área",
  quick: "Moves de prioridade", crafty: "Moves de status",
};

// "Este Move é classificado como Prioridade 3"
export const priorityOf = (raw) => Number(/Prioridade\s*(-?\d)/i.exec(raw?.Description ?? "")?.[1] ?? 0);

const INCAP = ["Asleep", "Frozen", "Stunned"];
const roundNow = async () => Number((await OBR.scene.getMetadata())["com.pretty-initiative/roundCount"] ?? 1);

// can this Pokémon react with this defense right now?
function canDefend(rules, sheet, name) {
  const p = sheet.pkmn;
  if (!p.moves?.[name] || p.hp.current <= 0) return false;
  const pp = rules.movePP(p, name);
  if (typeof pp === "number" && pp <= 0) return false;
  const c = conditionsOf(sheet), e = econOf(sheet);
  if (INCAP.some((k) => c[k]) || c.Confused || !e.reaction || e.loseAction) return false;
  if (sheet.battle?.charging?.invuln) return false;
  return true;
}

// what kind of move this is, for the protections
export function moveProfile(rules, move, raw, targets, area) {
  const self = move.rangeInfo?.kind === "self";
  return {
    single: !area && targets.length === 1,
    multi: area || targets.length > 1,
    damaging: !!move.damage,
    status: !move.damage && !self,
    priority: priorityOf(raw) > 0,
    melee: move.rangeInfo?.kind === "melee",
  };
}

// does protection `prot` (up on protector P) cover target T against this move?
async function covers(prot, P, T, mp) {
  const d = DEFENSES[prot.move];
  if (!d) return false;
  if (d.kind === "single") return P.id === T.id && mp.single;
  if (d.kind === "singleDamage") return P.id === T.id && mp.single && mp.damaging;
  const near = async () => P.id === T.id || (getSheet(T) && allies(getSheet(P), getSheet(T)) && (await distanceMeters(P, T)) <= d.radius + 0.05);
  if (d.kind === "wide") return mp.multi && mp.damaging && near();
  if (d.kind === "quick") return mp.priority && mp.damaging && near();
  if (d.kind === "crafty") return mp.status && near();
  return false;
}

// Pokémon of this team that could protect T with `name` now (the kind of move matters)
async function couldUse(rules, name, P, T, mp) {
  const d = DEFENSES[name];
  const ps = getSheet(P);
  if (!canDefend(rules, ps, name)) return false;
  const sameTeam = P.id === T.id || allies(ps, getSheet(T));
  if (!sameTeam) return false;
  if (d.kind === "upper") {
    if (!mp.priority) return false;
    // "um aliado dentro do alcance de seu deslocamento"
    const sp = rules.speeds(ps.pkmn);
    return P.id === T.id || (await distanceMeters(P, T)) <= Math.max(sp.walk, sp.fly, 1.5) + 0.05;
  }
  if (d.kind === "endure") return false; // asked when the damage is known
  return covers({ move: name }, P, T, mp);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// writes the requests and waits for the answers. asks: [{ P, options, targets, kind }]
// -> Map(protectorId -> answer)
async function ask(asks, attackerItem, moveLabel) {
  const answers = new Map();
  if (!asks.length) return answers;
  const req = crypto.randomUUID();
  for (const a of asks) {
    await updateSheet(a.P.id, (s) => {
      s.battle.defenseAsk = {
        req, kind: a.kind, attackerId: attackerItem.id, attackerName: attackerItem.name, move: moveLabel,
        targets: a.targets.map((t) => t.name), targetIds: a.targets.map((t) => t.id), options: a.options, at: Date.now(),
        damage: a.damage ?? null,
      };
      delete s.battle.defenseAnswer;
    });
  }
  const ids = asks.map((a) => a.P.id);
  const start = Date.now();
  // 5 s on the screen of whoever answers, plus the time to open it
  while (true) {
    await wait(250);
    const items = await OBR.scene.items.getItems(ids);
    let open = 0;
    for (const it of items) {
      const ans = getSheet(it)?.battle?.defenseAnswer;
      if (ans?.req === req && (ans.status === "done" || ans.status === "declined")) answers.set(it.id, ans);
      else if (ans?.req === req && ans.status === "accepted") open++; // rolling: wait for it
      else if (Date.now() - start < 7000) open++;
    }
    if (!open || Date.now() - start > 45000) break;
  }
  for (const id of ids) await updateSheet(id, (s) => { if (s.battle.defenseAsk?.req === req) delete s.battle.defenseAsk; });
  return answers;
}

// before the rolls: who is protected (already, or now). Returns
// { blocked: [{ id, note }], canceled: note|null, notes: [] } and applies contact effects to the attacker.
export async function defenses(rules, { attackerItem, move, raw, targets, area }) {
  const out = { blocked: [], canceled: null, notes: [] };
  const aSheet = getSheet(attackerItem);
  const mp = moveProfile(rules, move, raw, targets, area);
  // an enemy's move, or a damaging move from anyone (a friendly hit, or teams not set up yet)
  const hostile = targets.filter((t) => getSheet(t) && t.id !== attackerItem.id && (!allies(aSheet, getSheet(t)) || mp.damaging));
  if (!hostile.length) return out;
  const round = await roundNow();
  // everyone on the field (also who just came in by a switch and is waiting for the initiative)
  const others = await OBR.scene.items.getItems((i) => i.metadata?.[SHEET_KEY] && !i.metadata[SHEET_KEY].ball && (inInitiative(i) || i.metadata[SHEET_KEY].battle?.joinNextRound));
  const team = (t) => others.filter((o) => o.id !== attackerItem.id && (o.id === t.id || allies(getSheet(o), getSheet(t))));

  // 1) protections already up (one from before the last round is a leftover: gone)
  const covered = new Map(); // targetId -> { by, move }
  for (const t of hostile) {
    for (const P of team(t)) {
      const prot = getSheet(P).battle?.protection;
      if (prot && prot.round != null && prot.round < round - 1) continue;
      if (prot && await covers(prot, P, t, mp)) { covered.set(t.id, { by: P, move: prot.move }); break; }
    }
  }

  // 2) who could defend now
  const byP = new Map(); // P.id -> { P, options:Set, targets:[] }
  for (const t of hostile) {
    if (covered.has(t.id)) continue;
    for (const P of team(t)) {
      for (const name of Object.keys(DEFENSES)) {
        if (await couldUse(rules, name, P, t, mp)) {
          const e = byP.get(P.id) ?? { P, options: new Set(), targets: [] };
          e.options.add(name);
          if (!e.targets.some((x) => x.id === t.id)) e.targets.push(t);
          byP.set(P.id, e);
        }
      }
    }
  }
  const asks = [...byP.values()].map((e) => ({ P: e.P, options: [...e.options], targets: e.targets, kind: "guard" }));
  if (asks.length) out.notes.push(`esperou a reação de ${asks.map((a) => a.P.name).join(", ")}`);
  // why a target that knows Protect was not asked (the book: Protect only covers single-target moves)
  for (const t of hostile) {
    if (covered.has(t.id) || byP.has(t.id)) continue;
    const ts = getSheet(t);
    const known = Object.keys(DEFENSES).filter((n) => ts.pkmn.moves?.[n] && ["single", "singleDamage"].includes(DEFENSES[n].kind));
    if (!known.length) continue;
    const e = econOf(ts);
    const why = mp.multi ? "o move tem vários alvos (só Wide Guard protege)" : !e.reaction ? "já usou a reação" : e.loseAction ? "já adiantou a ação do próximo turno" : null;
    if (why) out.notes.push(`${t.name} não pôde usar ${known.join("/")}: ${why}`);
  }
  const answers = await ask(asks, attackerItem, move.label.replace(/ PMP$/, ""));

  // 3) the answers: new protections and Upper Hand
  for (const [pid, ans] of answers) {
    if (ans.status !== "done") continue;
    const P = others.find((o) => o.id === pid);
    if (ans.cancel) { out.canceled = `${P.name} reagiu com Upper Hand: o ataque foi cancelado`; return out; }
    if (!ans.ok) { out.notes.push(`${P.name} tentou ${ans.move}, mas falhou${ans.roll ? ` (${ans.roll})` : ""}`); continue; }
    const fresh = (await OBR.scene.items.getItems([pid]))[0];
    for (const t of hostile) {
      if (!covered.has(t.id) && await covers({ move: ans.move }, fresh, t, mp)) covered.set(t.id, { by: fresh, move: ans.move });
    }
  }

  // 4) blocked targets, and what touching them costs the attacker
  for (const [tid, c] of covered) {
    const t = hostile.find((x) => x.id === tid);
    out.blocked.push({ id: tid, note: `${t.name}: protegido por ${c.move}${c.by.id !== tid ? ` (de ${c.by.name})` : ""}, sem acerto nem dano` });
    const contact = DEFENSES[c.move]?.contact;
    if (contact && mp.melee && c.by.id === tid) await applyContact(rules, attackerItem, c.move, contact, out.notes);
  }
  return out;
}

async function applyContact(rules, attackerItem, moveName, contact, notes) {
  await updateSheet(attackerItem.id, (s) => {
    if (contact.status) {
      const r = giveCondition(s, contact.status, rules, {});
      notes.push(`${moveName}: ${attackerItem.name} ${r.ok ? `ficou ${CONDITIONS[contact.status].label}` : `(${r.reason})`}`);
    }
    for (const st of contact.stages ?? []) {
      addStage(s.pkmn, st.stat, st.delta);
      notes.push(`${moveName}: ${attackerItem.name} ${STAGES[st.stat]} ${st.delta > 0 ? "+" : ""}${st.delta}`);
    }
    if (contact.damageLevel) {
      const dmg = rules.level(s.pkmn);
      s.pkmn.hp.current = Math.max(0, s.pkmn.hp.current - dmg);
      notes.push(`${moveName}: ${attackerItem.name} tomou ${dmg} de dano`);
    }
  });
}

// Endure: damage that would knock a target out. changes: Map(id -> { damage }) (changed in place)
export async function endure(rules, { attackerItem, move, targets, changes, results }) {
  const asks = [];
  for (const t of targets) {
    const ch = changes.get(t.id);
    const s = getSheet(t);
    if (!ch?.damage || !s || allies(getSheet(attackerItem), s)) continue;
    const hp = s.pkmn.hp.current + (s.pkmn.hp.temp ?? 0);
    if (ch.damage < hp) continue;
    if (s.battle?.protection?.move === "Endure") { cap(ch, s, results, t); continue; }
    if (inInitiative(t) && canDefend(rules, s, "Endure")) asks.push({ P: t, options: ["Endure"], targets: [t], kind: "endure", damage: ch.damage });
  }
  const answers = await ask(asks, attackerItem, move.label.replace(/ PMP$/, ""));
  for (const [id, ans] of answers) {
    if (ans.status !== "done") continue;
    const t = targets.find((x) => x.id === id);
    const r = results.find((x) => x.targetId === id);
    if (ans.ok) cap(changes.get(id), getSheet((await OBR.scene.items.getItems([id]))[0]), results, t);
    else if (r) r.effects.push(`Endure falhou${ans.roll ? ` (${ans.roll})` : ""}`);
  }
}

function cap(ch, s, results, t) {
  const hp = s.pkmn.hp.current + (s.pkmn.hp.temp ?? 0);
  ch.damage = Math.max(0, hp - 1);
  results.find((x) => x.targetId === t.id)?.effects.push("aguentou com Endure (1 HP)");
}

// ------------------------------------------------------------------ the defender's side (defend.js)

// the book's rule for using these in a row: 1d6 per consecutive success (max 6d6), all 5 or 6.
// Wide/Quick Guard don't lose accuracy after themselves, but count for the others.
export function streakDice(sheet, name, round) {
  const st = sheet.battle?.guardStreak;
  const d = DEFENSES[name];
  if (!d?.streak || !st || st.round !== round - 1 || !st.n) return { dice: 0, prev: 0 };
  if (d.guard && DEFENSES[st.last]?.guard) return { dice: 0, prev: st.n };
  return { dice: Math.min(6, st.n), prev: st.n };
}

// spends the reaction, the next action and 1 PP; sets the protection when it worked
export async function commitDefense(rules, P, name, ok, settings) {
  const round = await roundNow();
  await updateSheet(P.id, (s) => {
    const pp = rules.movePP(s.pkmn, name);
    if (settings.autoPP && typeof pp === "number" && s.pkmn.moves[name]) s.pkmn.moves[name].pp = Math.max(0, pp - 1);
    s.battle.econ = { ...econOf(s), reaction: false, loseAction: true };
    const d = DEFENSES[name];
    if (d?.streak) {
      const st = s.battle.guardStreak;
      const prev = st && st.round === round - 1 ? st.n : 0;
      s.battle.guardStreak = ok ? { n: prev + 1, round, last: name } : { n: 0, round, last: name };
    }
    if (ok && d && d.kind !== "upper") s.battle.protection = { move: name, kind: d.kind, round, at: Date.now() };
  });
}

export const defenseText = (name) => {
  const d = DEFENSES[name];
  if (!d) return "";
  if (d.kind === "upper") return "contra-ataca; se acertar, atordoa e cancela o ataque";
  if (d.kind === "endure") return "fica com 1 HP em vez de desmaiar, até o seu próximo turno";
  const c = d.contact;
  const touch = !c ? "" : c.damageLevel ? "; quem atacar corpo a corpo toma dano igual ao nível"
    : c.status ? `; quem atacar corpo a corpo fica ${CONDITIONS[c.status].label.toLowerCase()}`
    : `; quem atacar corpo a corpo: ${c.stages.map((s) => `${STAGES[s.stat]} ${s.delta}`).join(", ")}`;
  return `bloqueia ${KIND_PT[d.kind]}${d.radius ? ` (você e aliados a até ${fmtM(d.radius)})` : ""} até o seu próximo turno${touch}`;
};
export { roundNow };
