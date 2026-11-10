// "Preparar batalha": two or more trainers, a format (1v1, 2v2, 3v3 = Pokémon on the field per side),
// how many reserves each trainer may use, an arena marked on the map, and each side picking its
// starters without seeing the others'. When everyone is ready the battle starts by itself; between the
// GM's own trainers it can also be SIMULATED (an AI plays the turns) and ends with a summary.
//
// State in the scene metadata (PREP_KEY):
//   { id, by, status: "setup" | "running" | "done", configured, format, reserves, arena: {x1,y1,x2,y2}|null,
//     sim, trainers: { [trainerId]: { side, actives, ready, starters: [ids], used } }, result }
// Each trainer's controller only writes its own entry; the UI shows the others as "escolhendo"/"pronto".
import { OBR, ID, SHEET_KEY, getSheet, updateSheet, pushLog } from "./store.js?v=0.9.13";
import { PRETTY, isActive, passTurn, moveTiming, conditionsOf, TEAMS } from "./battle.js?v=0.9.13";
import { TRAINER, trainerOf, party, store, release, inBall, joinInitiativeNow, entryAbilities } from "./trainer.js?v=0.9.13";
import { startCombat } from "./qol.js?v=0.9.13";
import { distanceMeters, pointMeters } from "./map.js?v=0.9.13";
import { approach, moveToken, movement } from "./tactics.js?v=0.9.13";
import { useMove } from "./combat.js?v=0.9.13";
import { isAreaTurn } from "./field.js?v=0.9.13";

export const PREP_KEY = `${ID}/prep`;
export const ARENA_KEY = `${ID}/arena`;
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
  return setPrep(() => ({
    id: crypto.randomUUID(), by: OBR.player.id, at: Date.now(), status: "setup", configured: false,
    format: 1, reserves: 2, arena: null, sim: false, trainers: entries, result: null,
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
  prep = await setPrep((p) => ({ ...p, status: "running", startedAt: Date.now() }));
  const starters = [];
  for (const [tid, t] of Object.entries(prep.trainers)) {
    const [trainer] = await OBR.scene.items.getItems([tid]);
    if (!trainer) continue;
    for (const p of await party(tid)) {
      const s = getSheet(p);
      if (!inBall(s) && !t.starters.includes(p.id)) await store(rules, p, trainer, { quiet: true });
    }
    for (const id of t.starters) {
      const [p] = await OBR.scene.items.getItems([id]);
      if (!p) continue;
      const pos = await spotNear(trainer.position, prep.arena, [p.id]);
      if (inBall(getSheet(p))) await release(rules, p, trainer, { pos, quiet: true });
      else await OBR.scene.items.updateItems([p.id], (ds) => { for (const d0 of ds) d0.position = pos; });
      // the side chosen here is the team for the fight
      await updateSheet(p.id, (s) => { s.team = t.side; });
      starters.push((await OBR.scene.items.getItems([p.id]))[0]);
    }
  }
  await setPrep((p) => { for (const [tid, t] of Object.entries(p.trainers)) t.used = t.starters.length; return p; });
  const names = Object.keys(prep.trainers).map((tid) => tid);
  const tNames = (await OBR.scene.items.getItems(names)).map((t) => t.name);
  await pushLog({ kind: "note", attacker: "Batalha", text: `começou: ${tNames.join(" × ")} (${prep.format}v${prep.format}, ${prep.reserves} reserva(s) cada)${prep.sim ? " — simulada" : ""}` });
  await startCombat(rules, starters);
  for (const s of starters) await entryAbilities(rules, (await OBR.scene.items.getItems([s.id]))[0]).catch(() => {});
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
      await updateSheet(next.id, (s) => { s.team = t.side; s.battle.econ = { action: false, bonus: true, reaction: true }; });
      await joinInitiativeNow(rules, next);
      await entryAbilities(rules, (await OBR.scene.items.getItems([next.id]))[0]).catch(() => {});
      t.used = (t.used ?? 0) + 1;
      out++;
      notes.push(`${trainer.name} mandou ${next.name}`);
      await pushLog({ kind: "note", attacker: trainer.name, text: `mandou ${next.name} (reserva ${t.used - limit} de ${prep.reserves})` });
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
// The best damaging move ("1 ação") on the enemy it hurts the most, walking up to it inside the arena.
const REACTION_ONLY = (raw) => { const t = moveTiming(raw); return t.reaction && !t.action && !t.bonus; };
export async function aiTurn(rules, item, prep) {
  const me = (await OBR.scene.items.getItems([item.id]))[0];
  const s = getSheet(me);
  if (!s || s.pkmn.hp.current <= 0) return null;
  const all = await participants(prep);
  const mySide = sideOf(prep, me);
  const enemies = all.filter((o) => !inBall(getSheet(o)) && getSheet(o).pkmn.hp.current > 0 && sideOf(prep, o) !== mySide);
  if (!enemies.length) return null;
  const choices = [];
  for (const name of Object.keys(s.pkmn.moves ?? {})) {
    const raw = rules.moves[name] ?? {};
    const md = rules.moveData(s.pkmn, name);
    if (!md.damage || (typeof md.pp === "number" && md.pp <= 0) || REACTION_ONLY(raw)) continue;
    if (!moveTiming(raw).action || ["self", "area"].includes(md.rangeInfo?.kind)) continue;
    for (const e of enemies) {
      const eff = rules.effectiveness(md.type, getSheet(e).pkmn);
      if (eff === 0) continue;
      const avg = ((md.damage.amount * (md.damage.dice + 1)) / 2 + md.damage.bonus) * (md.damage.times || 1) * (md.hits || 1) * eff;
      const finish = getSheet(e).pkmn.hp.current <= avg ? 1.3 : 1; // can knock it out: better
      const need = Math.max(0, (await distanceMeters(me, e)) - (md.rangeInfo?.meters ?? 1.5));
      choices.push({ name, md, e, need, score: avg * finish - need * 0.5 });
    }
  }
  choices.sort((a, b) => b.score - a.score);
  if (!choices.length) choices.push(...enemies.map((e) => ({ name: "Struggle", md: rules.moveData(s.pkmn, "Struggle"), e, need: 1, score: 0 })));
  const left = movement(rules, me).left;
  for (const c of choices) {
    let cur = (await OBR.scene.items.getItems([me.id]))[0];
    if (c.need > 0.05) {
      const spot = await approach(rules, cur, c.e, c.md, { maxCost: left }).catch(() => null);
      if (!spot || !inArena(prep.arena, spot.pos)) continue;
      await moveToken(me.id, spot.pos, spot.cost);
      cur = (await OBR.scene.items.getItems([me.id]))[0];
    }
    try {
      const entry = await useMove(rules, cur, c.name, [(await OBR.scene.items.getItems([c.e.id]))[0]], {});
      return { move: c.name, target: c.e, entry };
    } catch { /* out of range, no action, restricted: try the next one */ }
  }
  // nobody in reach: walk towards the nearest enemy (inside the arena)
  const near = enemies.sort((a, b) => Math.hypot(a.position.x - me.position.x, a.position.y - me.position.y) - Math.hypot(b.position.x - me.position.x, b.position.y - me.position.y))[0];
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
      // the GM's watcher runs the start of each turn first (conditions, weather...)
      if (!active || meta[TURN_KEY]?.activeId !== active.id) { await wait(250); continue; }
      if (isAreaTurn(active)) { await wait(300); continue; } // the watcher passes those
      const s = getSheet(active);
      const ids = Object.keys(prep.trainers);
      if (!s || !ids.includes(s.trainer)) { await passTurn(active.id); await wait(400); continue; }
      if (s.battle?.joinRound != null && stats.round < s.battle.joinRound) { await wait(300); continue; }
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
  const { buildShape } = (await import("./store.js?v=0.9.13")).SDK;
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

// is this trainer played by the GM? (its owner is the GM, or a player who isn't in the room)
export async function npcTrainer(trainer, gmId, players) {
  const owner = trainerOf(trainer)?.owner;
  return !owner || owner === gmId || !players.some((p) => p.id === owner);
}
export { TRAINER };
