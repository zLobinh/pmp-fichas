// Trainers: a token that carries up to 6 Pokémon. "Absorbing" a Pokémon keeps its own token and sheet:
// the token goes into the "pokéball" (invisible, locked, small, under the trainer: players don't see
// it, the GM sees a faint icon) and comes back out next to the trainer.
//
// Trainer token: metadata[TRAINER] = { owner, team }.
// Pokémon sheet: trainer (trainer item id), slot (0-5), ball { scale } while stored,
//   battle.needsInitiative (rolls at the start of the next round), battle.mustSwitch, battle.trapped.
//
// Rules (Livro de Regras pág. 50 and the move/ability texts):
//   - switching a Pokémon in combat costs the action (the one coming in only has bonus action and
//     reaction this turn), keeps the initiative position and the new one rolls at the next round;
//     a fainted one is switched for free and the new one only joins at the next round;
//   - recalling needs the trainer within 18 m; out it comes within 4,5 m of the trainer;
//   - back in the ball: stages, concentration and protections end; conditions stay;
//   - traps (Mean Look, Shadow Tag...) stop voluntary switches; forced switches (Dragon Tail,
//     Whirlwind...) and switching moves (U-turn...) go through them.
import { OBR, SDK, ID, SHEET_KEY, getSheet, updateSheet, pushLog } from "./store.js?v=0.9.4";
import { d, fmtM } from "./rules.js?v=0.9.4";
import { CONDITIONS, conditionsOf, clearCondition, addStage, econOf, inInitiative, isActive, allies, PRETTY, passTurn, teamOf } from "./battle.js?v=0.9.4";
import { distanceMeters, altitudeOf, rollInitiative } from "./map.js?v=0.9.4";

export const TRAINER = `${ID}/trainer`;
export const MAX_PARTY = 6;
const BALL_SCALE = 0.35;
export const trainerOf = (item) => item?.metadata?.[TRAINER] ?? null;
export const inBall = (sheet) => !!sheet?.ball;

const running = async () => (await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY]?.active === true)).length > 0;
const roundNow = async () => Number((await OBR.scene.getMetadata())["com.pretty-initiative/roundCount"] ?? 1);

// the trainer's Pokémon, in slot order
export async function party(trainerId) {
  const list = await OBR.scene.items.getItems((i) => i.metadata?.[SHEET_KEY]?.trainer === trainerId);
  return list.sort((a, b) => (getSheet(a).slot ?? 9) - (getSheet(b).slot ?? 9));
}

export async function canManage(trainerItem) {
  if ((await OBR.player.getRole()) === "GM") return true;
  return trainerOf(trainerItem)?.owner === OBR.player.id;
}

export async function makeTrainer(item, { owner, team }) {
  await OBR.scene.items.updateItems([item.id], (ds) => { for (const d0 of ds) d0.metadata[TRAINER] = { owner, team }; });
  await pushLog({ kind: "note", attacker: item.name, text: "agora é um treinador (até 6 Pokémon)" });
}

export async function unmakeTrainer(item) {
  const list = await party(item.id);
  if (list.some((p) => inBall(getSheet(p)))) throw new Error("Libere ou desvincule os Pokémon guardados antes.");
  for (const p of list) await updateSheet(p.id, (s) => { delete s.trainer; delete s.slot; });
  await OBR.scene.items.updateItems([item.id], (ds) => { for (const d0 of ds) delete d0.metadata[TRAINER]; });
}

// links Pokémon tokens to a trainer and stores them in the ball
export async function link(rules, trainerItem, pokemonItems) {
  const t = trainerOf(trainerItem);
  if (!t) throw new Error("Esse token não é um treinador.");
  const current = await party(trainerItem.id);
  const fresh = pokemonItems.filter((p) => getSheet(p) && getSheet(p).trainer !== trainerItem.id);
  if (current.length + fresh.length > MAX_PARTY) throw new Error(`Um treinador leva no máximo ${MAX_PARTY} Pokémon (já tem ${current.length}).`);
  const isGM = (await OBR.player.getRole()) === "GM";
  const used = new Set(current.map((p) => getSheet(p).slot));
  for (const p of fresh) {
    const s = getSheet(p);
    if (!isGM && s.owner !== OBR.player.id) throw new Error(`${p.name} não é seu.`);
    if (s.trainer) throw new Error(`${p.name} já é de outro treinador.`);
    let slot = 0;
    while (used.has(slot)) slot++;
    used.add(slot);
    await updateSheet(p.id, (sh) => { sh.trainer = trainerItem.id; sh.slot = slot; sh.owner = t.owner; sh.team = t.team; });
  }
  for (const p of fresh) await store(rules, (await OBR.scene.items.getItems([p.id]))[0], trainerItem, { quiet: true });
  await pushLog({ kind: "note", attacker: trainerItem.name, text: `guardou ${fresh.map((p) => p.name).join(", ")} na pokébola` });
}

export async function unlink(pokemon) {
  const s = getSheet(pokemon);
  if (inBall(s)) throw new Error("Libere o Pokémon antes de desvincular.");
  await updateSheet(pokemon.id, (sh) => { delete sh.trainer; delete sh.slot; });
}

// ------------------------------------------------------------------ in and out of the ball

// leaving the field: what the book and the abilities say
function exitEffects(rules, s, inCombat, notes) {
  s.pkmn.stages = {};
  delete s.battle.charging;
  delete s.battle.protection;
  delete s.battle.prepared;
  delete s.battle.helped;
  delete s.battle.trapped;
  delete s.battle.mustSwitch;
  delete s.battle.alt;
  delete s.battle.oa;
  const abil = rules.abilities(s.pkmn);
  if (abil.includes("Natural Cure")) {
    for (const k of Object.keys(conditionsOf(s))) if (CONDITIONS[k]?.nonVolatile && clearCondition(s, k, { grace: false })) notes.push(`Natural Cure curou ${CONDITIONS[k].label}`);
  }
  if (inCombat && abil.includes("Regenerator") && s.pkmn.hp.current > 0) {
    const heal = Math.max(3, Math.floor(rules.level(s.pkmn) * 1.5));
    s.pkmn.hp.current = Math.min(rules.maxHP(s.pkmn), s.pkmn.hp.current + heal);
    notes.push(`Regenerator: +${heal} HP`);
  }
}

// takes it out of Pretty Sordid (passing the turn on when it was its turn and nobody replaces it)
async function leaveInitiativeQuiet(item, { pass = true } = {}) {
  if (!inInitiative(item)) return;
  const meta = await OBR.scene.getMetadata();
  const order = Object.values(meta["com.pretty-initiative/order"] ?? {}).filter((id) => id !== item.id);
  if (pass && isActive(item)) await passTurn(item.id);
  await OBR.scene.items.updateItems([item.id], (ds) => { for (const d0 of ds) delete d0.metadata[PRETTY]; });
  await OBR.scene.setMetadata({ "com.pretty-initiative/order": Object.fromEntries(order.map((id, i) => [i, id])) });
}

// into the ball: hidden, locked and small under the trainer
export async function store(rules, pokemon, trainerItem, { quiet = false, pass = true } = {}) {
  const s0 = getSheet(pokemon);
  if (inBall(s0)) return;
  const inCombat = await running();
  const notes = [];
  await leaveInitiativeQuiet(pokemon, { pass });
  await updateSheet(pokemon.id, (s, dr) => {
    exitEffects(rules, s, inCombat, notes);
    s.ball = { scale: { ...(dr.scale ?? { x: 1, y: 1 }) }, layer: dr.layer };
    dr.visible = false;
    dr.locked = true;
    dr.disableHit = true;
    dr.position = { ...trainerItem.position };
    dr.scale = { x: (dr.scale?.x ?? 1) * BALL_SCALE, y: (dr.scale?.y ?? 1) * BALL_SCALE };
  });
  if (!quiet) await pushLog({ kind: "note", attacker: trainerItem.name, text: `recolheu ${pokemon.name}${notes.length ? ` (${notes.join("; ")})` : ""}` });
}

// a free square around a point (rings of 1, 2, 3 squares)
async function freeSpotNear(center, exceptIds = []) {
  const dpi = await OBR.scene.grid.getDpi();
  const others = (await OBR.scene.items.getItems((i) => (i.layer === "CHARACTER" || i.layer === "MOUNT") && i.visible !== false && !exceptIds.includes(i.id)))
    .map((i) => i.position);
  const free = (p) => !others.some((o) => Math.abs(o.x - p.x) < dpi * 0.5 && Math.abs(o.y - p.y) < dpi * 0.5);
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const p = { x: center.x + dx * dpi, y: center.y + dy * dpi };
      if (free(p)) return p;
    }
  }
  return { x: center.x + dpi, y: center.y };
}

// out of the ball, next to the trainer (or on `pos`)
export async function release(rules, pokemon, trainerItem, { pos = null, quiet = false } = {}) {
  const s0 = getSheet(pokemon);
  if (!inBall(s0)) return;
  const at = pos ?? await freeSpotNear(trainerItem.position, [pokemon.id]);
  await updateSheet(pokemon.id, (s, dr) => {
    dr.scale = { ...(s.ball?.scale ?? { x: 1, y: 1 }) };
    dr.visible = true;
    dr.locked = false;
    dr.disableHit = false;
    dr.position = { ...at };
    delete s.ball;
    s.battle.move = { used: 0, pos: { ...at } };
  });
  if (!quiet) await pushLog({ kind: "note", attacker: trainerItem.name, text: `liberou ${pokemon.name}` });
  return at;
}

// ------------------------------------------------------------------ trapped?

const GHOST_IMMUNE = new Set(["Mean Look", "Block", "Fairy Lock", "Shadow Tag", "Arena Trap", "Magnet Pull"]);

// null, or the reason it can't be switched out voluntarily
export async function trappedBy(rules, item) {
  const s = getSheet(item);
  const types = rules.types(s.pkmn);
  const ghost = types.includes("Ghost");
  const t = s.battle?.trapped;
  if (t) {
    const expired = t.round != null && (await roundNow()) > t.round;
    if (!expired && !(ghost && GHOST_IMMUNE.has(t.move))) return `${t.move}${t.byName ? ` de ${t.byName}` : ""}`;
  }
  if (ghost) return null;
  // abilities of enemies on the field
  const enemies = await OBR.scene.items.getItems((i) => i.id !== item.id && i.metadata?.[SHEET_KEY] && !inBall(getSheet(i)) && !allies(getSheet(i), s));
  for (const e of enemies) {
    const es = getSheet(e);
    if (es.pkmn.hp.current <= 0) continue;
    const ab = rules.abilities(es.pkmn);
    const dist = () => distanceMeters(e, item);
    if (ab.includes("Shadow Tag") && (await dist()) <= 18.05) return `Shadow Tag de ${e.name}`;
    if (ab.includes("Arena Trap") && altitudeOf(item) === 0 && (await dist()) <= 15.05) return `Arena Trap de ${e.name}`;
    if (ab.includes("Magnet Pull") && types.includes("Steel") && (await dist()) <= 18.05) return `Magnet Pull de ${e.name}`;
  }
  return null;
}

// ------------------------------------------------------------------ switching

// healthy Pokémon waiting in the ball
export async function bench(trainerId) {
  return (await party(trainerId)).filter((p) => inBall(getSheet(p)) && getSheet(p).pkmn.hp.current > 0);
}

// out -> in. opts: forced (Dragon Tail...), free (U-turn...: no action), batonPass (stages go along)
export async function switchPokemon(rules, outItem, inItem, opts = {}) {
  const outS = getSheet(outItem), inS = getSheet(inItem);
  const [trainerItem] = await OBR.scene.items.getItems([outS.trainer]);
  if (!trainerItem) throw new Error("O treinador desse Pokémon não está mais no mapa.");
  if (inS.trainer !== outS.trainer || !inBall(inS)) throw new Error(`${inItem.name} não está na pokébola desse treinador.`);
  if (inS.pkmn.hp.current <= 0) throw new Error(`${inItem.name} está desmaiado.`);
  const combat = await running();
  const fainted = outS.pkmn.hp.current <= 0;
  const tracked = combat && inInitiative(outItem);
  if (tracked && !fainted && !opts.forced && !opts.free) {
    // a voluntary switch: on its own turn, with the action
    if (!isActive(outItem)) throw new Error("Só dá pra trocar no turno do Pokémon (ou por um Move que force a troca).");
    if (!econOf(outS).action) throw new Error("A troca gasta a ação, e a ação deste turno já foi usada.");
    const trap = await trappedBy(rules, outItem);
    if (trap) throw new Error(`${outItem.name} está preso (${trap}) e não pode ser trocado.`);
  }
  if (combat && !fainted && (await distanceMeters(trainerItem, outItem)) > 18.05 && !opts.forced) {
    throw new Error(`O treinador precisa estar a até 18 m de ${outItem.name} pra recolher (está a ${fmtM(Math.round((await distanceMeters(trainerItem, outItem)) * 10) / 10)}).`);
  }
  const stages = opts.batonPass ? { ...(outS.pkmn.stages ?? {}) } : null;
  const pretty = outItem.metadata?.[PRETTY] ? { ...outItem.metadata[PRETTY] } : null;
  const pos = { ...outItem.position };
  // (the order before the one leaving is taken out of it: the new one takes the same place)
  const order0 = Object.values((await OBR.scene.getMetadata())["com.pretty-initiative/order"] ?? {});

  // the one coming in takes the place on the field and in the initiative
  await store(rules, outItem, trainerItem, { quiet: true, pass: false });
  await release(rules, inItem, trainerItem, { pos, quiet: true });
  if (tracked && pretty && !fainted) {
    const order = order0.map((id) => (id === outItem.id ? inItem.id : id));
    if (!order.includes(inItem.id)) order.push(inItem.id);
    await OBR.scene.items.updateItems([inItem.id], (ds) => { for (const d0 of ds) d0.metadata[PRETTY] = { ...pretty }; });
    await OBR.scene.setMetadata({ "com.pretty-initiative/order": Object.fromEntries(order.map((id, i) => [i, id])) });
  } else if (tracked && pretty && fainted) {
    // the fainted one was already out of the initiative (or leaves now); the new one joins next round
    await leaveInitiativeQuiet(outItem);
  }
  await updateSheet(inItem.id, (s) => {
    // "o Pokémon que entra só tem ação bônus e reação"
    s.battle.econ = { action: false, bonus: true, reaction: true };
    if (combat) s.battle.needsInitiative = true;
    if (combat && (fainted || !pretty)) s.battle.joinNextRound = true;
    if (stages) s.pkmn.stages = stages;
    s.battle.enteredRound = null;
  });
  // the action of the one that left (voluntary switch)
  if (tracked && !fainted && !opts.forced && !opts.free) await updateSheet(outItem.id, (s) => { s.battle.econ = { ...econOf(s), action: false }; });
  const why = opts.forced ? ` (forçado por ${opts.by})` : opts.free ? ` (${opts.by}, ação livre)` : fainted ? " (desmaiado: ação livre)" : tracked ? " (gastou a ação)" : "";
  await pushLog({ kind: "note", attacker: trainerItem.name, text: `trocou ${outItem.name} por ${inItem.name}${why}${stages ? " — Baton Pass passou os estágios" : ""}${combat ? "; o novo rola iniciativa no começo da próxima rodada" : ""}` });
  await entryAbilities(rules, (await OBR.scene.items.getItems([inItem.id]))[0]);
}

// a forced switch to a random healthy one (Dragon Tail, Circle Throw); null when it can't
export async function forceRandomSwitch(rules, target, by) {
  const s = getSheet(target);
  if (!s?.trainer) return `${target.name} é selvagem: foge se o nível dele for menor que o do atacante`;
  const ab = rules.abilities(s.pkmn);
  if (ab.includes("Guard Dog") || ab.includes("Suction Cups")) return `${target.name} não pode ser forçado a sair (${ab.includes("Guard Dog") ? "Guard Dog" : "Suction Cups"})`;
  const options = await bench(s.trainer);
  if (!options.length) return `${target.name} não tem com quem trocar`;
  const pick = options[Math.floor(Math.random() * options.length)];
  await switchPokemon(rules, target, pick, { forced: true, by });
  return `${target.name} foi trocado à força por ${pick.name}`;
}

// ------------------------------------------------------------------ abilities when entering

export async function entryAbilities(rules, item) {
  if (!item || !(await running())) return;
  const s = getSheet(item);
  const ab = rules.abilities(s.pkmn);
  const notes = [];
  const mod = (v) => Math.floor((v - 10) / 2);
  const all = await OBR.scene.items.getItems((i) => i.id !== item.id && i.metadata?.[SHEET_KEY] && !inBall(getSheet(i)) && getSheet(i).pkmn.hp.current > 0);
  const near = async (list, m) => { const out = []; for (const o of list) if ((await distanceMeters(item, o)) <= m + 0.05) out.push(o); return out; };
  const enemies = all.filter((o) => !allies(getSheet(o), s));
  const friends = all.filter((o) => allies(getSheet(o), s));
  const once = (key) => { if (s.battle?.once?.[key]) return false; return true; };

  if (ab.includes("Intimidate")) {
    const a = rules.attributes(s.pkmn);
    const dc = 8 + rules.proficiency(s.pkmn) + Math.max(mod(a.STR), mod(a.CHA));
    for (const e of await near(enemies, 9)) {
      const es = getSheet(e);
      if (rules.abilities(es.pkmn).includes("Guard Dog")) { await updateSheet(e.id, (x) => addStage(x.pkmn, "Attack", 1)); notes.push(`${e.name} (Guard Dog) Ataque +1`); continue; }
      const n = d(20), total = n + (rules.saves(es.pkmn).WIS ?? 0);
      if (n === 1 || (n !== 20 && total < dc)) { await updateSheet(e.id, (x) => addStage(x.pkmn, "Attack", -1)); notes.push(`${e.name} falhou (SAB ${total} vs CD ${dc}): Ataque −1`); }
      else notes.push(`${e.name} resistiu (SAB ${total} vs CD ${dc})`);
    }
  }
  const selfStage = async (key, stat, label) => {
    if (!once(key)) return;
    await updateSheet(item.id, (x) => { addStage(x.pkmn, stat, 1); x.battle.once = { ...(x.battle.once ?? {}), [key]: true }; });
    notes.push(`${label}: +1`);
  };
  if (ab.includes("Intrepid Sword")) await selfStage("intrepid", "Attack", "Intrepid Sword, Ataque");
  if (ab.includes("Dauntless Shield")) await selfStage("dauntless", "Defense", "Dauntless Shield, Defesa");
  if (ab.includes("Supersweet Syrup") && once("syrup")) {
    for (const e of await near(enemies, 4.5)) { await updateSheet(e.id, (x) => addStage(x.pkmn, "Evasion", -1)); notes.push(`${e.name} Evasão −1`); }
    await updateSheet(item.id, (x) => { x.battle.once = { ...(x.battle.once ?? {}), syrup: true }; });
  }
  if (ab.includes("Hospitality")) {
    const hurt = (await near(friends, 9)).filter((o) => getSheet(o).pkmn.hp.current < rules.maxHP(getSheet(o).pkmn));
    if (hurt.length) {
      const o = hurt[0];
      const heal = Math.max(2, rules.level(getSheet(o).pkmn));
      await updateSheet(o.id, (x) => { x.pkmn.hp.current = Math.min(rules.maxHP(x.pkmn), x.pkmn.hp.current + heal); });
      notes.push(`Hospitality: ${o.name} +${heal} HP`);
    }
  }
  const field = { Drizzle: "chuva (Rain Dance)", Drought: "sol forte (Sunny Day)", "Sand Stream": "tempestade de areia", "Snow Warning": "granizo/neve",
    "Electric Surge": "Electric Terrain", "Grassy Surge": "Grassy Terrain", "Misty Surge": "Misty Terrain", "Psychic Surge": "Psychic Terrain",
    "Hadron Engine": "Electric Terrain", "Orichalcum Pulse": "sol forte" };
  for (const [k, v] of Object.entries(field)) if (ab.includes(k)) notes.push(`${k}: ${v} (aplique o clima/terreno)`);
  for (const k of ["Download", "Trace", "Imposter", "Costar", "Curious Medicine", "Moody", "Anticipation", "Forewarn", "Screen Cleaner"]) {
    if (ab.includes(k)) notes.push(`${k}: confira o efeito ao entrar`);
  }
  if (notes.length) await pushLog({ kind: "note", attacker: item.name, text: `entrou em campo — ${notes.join("; ")}` });
}

// ------------------------------------------------------------------ moves that switch or trap

// forced switch of the target: "random" (Dragon Tail, Circle Throw) or the trainer chooses (Roar, Whirlwind)
export const FORCE = {
  "Dragon Tail": { when: "hit", pick: "random" },
  "Circle Throw": { when: "hit", pick: "random" },
  Roar: { when: "contest", pick: "owner" },
  Whirlwind: { when: "fail", pick: "owner", wind: true },
};
// the user switches out afterwards, as a free action
export const SELF_SWITCH = {
  "U-Turn": "used", "Volt Switch": "used", "Flip Turn": "hit", "Parting Shot": "contest",
  "Baton Pass": "used", "Chilly Reception": "used", "Shed Tail": "used",
};
// who gets trapped, and when
export const TRAPS = {
  "Mean Look": { who: "target", when: "contest" },
  Block: { who: "target", when: "used" },
  "Spider Web": { who: "target", when: "hit" },
  "Spirit Shackle": { who: "target", when: "hit" },
  "Anchor Shot": { who: "target", when: "hit" },
  "Thousand Waves": { who: "target", when: "fail" },
  "Jaw Lock": { who: "both", when: "hit" },
  Octolock: { who: "target", when: "hit" },
  "Snap Trap": { who: "target", when: "hit" },
  "Thunder Cage": { who: "target", when: "hit" },
  "Fairy Lock": { who: "target", when: "used", round: true },
  Ingrain: { who: "self", when: "used" },
  "No Retreat": { who: "self", when: "used" },
};

// did `when` happen for this result?
export function happened(when, r) {
  if (when === "used") return true;
  if (when === "hit") return !!(r?.attack ? r.attack.hit : r?.damage);
  if (when === "contest") return !!r?.contest?.success;
  if (when === "fail") return !!(r?.save && !r.save.unknown && !r.save.success);
  return false;
}

// marks Pokémon as trapped (in their sheets)
export async function trap(rules, moveName, byItem, items) {
  const rule = TRAPS[moveName];
  const round = rule.round ? await roundNow() : null;
  const done = [];
  for (const it of items) {
    const s = getSheet(it);
    if (!s) continue;
    if (GHOST_IMMUNE.has(moveName) && rules.types(s.pkmn).includes("Ghost")) continue;
    await updateSheet(it.id, (x) => { x.battle.trapped = { move: moveName, by: byItem.id, byName: byItem.name, ...(round != null ? { round } : {}) }; });
    done.push(it.name);
  }
  return done;
}

// start of a round: whoever came in by a switch rolls initiative (and the ones that came in for a
// fainted Pokémon join the initiative now)
export async function rollPending(rules) {
  const list = await OBR.scene.items.getItems((i) => i.metadata?.[SHEET_KEY]?.battle?.needsInitiative && !i.metadata[SHEET_KEY].ball);
  for (const it of list) {
    if (getSheet(it).pkmn.hp.current <= 0) continue;
    await rollInitiative(rules, it);
    await updateSheet(it.id, (s) => { delete s.battle.needsInitiative; delete s.battle.joinNextRound; });
  }
}

export { teamOf };
