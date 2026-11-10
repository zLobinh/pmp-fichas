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
import { OBR, SDK, ID, SHEET_KEY, getSheet, updateSheet, pushLog, parseExport } from "./store.js?v=0.9.9";
import { d, fmtM } from "./rules.js?v=0.9.9";
import { CONDITIONS, conditionsOf, clearCondition, addStage, econOf, inInitiative, isActive, allies, PRETTY, passTurn, teamOf } from "./battle.js?v=0.9.9";
import { distanceMeters, altitudeOf, rollInitiative } from "./map.js?v=0.9.9";
import { FIELD_ABILITIES, startField, clearSide } from "./field.js?v=0.9.9";
import { abilitiesOf, stageGuard } from "./abilities.js?v=0.9.9";

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

// ------------------------------------------------------------------ a Pokémon from the app's code
// The sprites are the ones of the "Imagem por Link" extension (same list: pokemon/index.json):
// the export code from the PMP app becomes a token with its sprite, the right size and the sheet,
// already in this trainer's pokéball.
export const SPRITES = "https://zlobinh.github.io/mapas/pokemon/";
let spriteIndex = null;
async function sprites() {
  spriteIndex ??= fetch(`${SPRITES}index.json`).then((r) => r.json()).catch((e) => { spriteIndex = null; throw new Error(`Não achei a lista de Pokémon (${e.message})`); });
  return spriteIndex;
}
// the best sprite for this Pokémon: same Pokédex number (or name), the female one for females,
// otherwise the plain one
export async function spriteFor(rules, pkmn) {
  const list = await sprites();
  // by the species name first, then the PMP Pokédex number of the species; the "number" in the
  // app's export is not always the national one (a Lycanroc came with Whismur's 293)
  const name = (pkmn.species?.current ?? "").toLowerCase();
  const dex = Number(rules.speciesData(pkmn)?.index);
  let pool = list.filter((e) => e.n.toLowerCase() === name);
  if (!pool.length) pool = list.filter((e) => e.d === dex);
  if (!pool.length) pool = list.filter((e) => name.startsWith(e.n.toLowerCase())).sort((a, b) => b.n.length - a.n.length);
  if (!pool.length) pool = list.filter((e) => e.d === Number(pkmn.number));
  if (!pool.length) return null;
  pool = pool.filter((e) => e.n === pool[0].n);
  const female = /^f/i.test(pkmn.gender ?? "") || /female|f[eê]mea/i.test(pkmn.gender ?? "");
  const word = name.replace(pool[0].n.toLowerCase(), "").trim(); // "vulpix alola" -> "alola"
  return (word ? pool.find((e) => e.v.toLowerCase().includes(word)) : null)
    ?? (female ? pool.find((e) => /f[eê]mea/i.test(e.v)) : null)
    ?? pool.find((e) => !e.v) ?? pool[0];
}
export async function createFromCode(rules, trainerItem, code) {
  const t = trainerOf(trainerItem);
  if (!t) throw new Error("Esse token não é um treinador.");
  if ((await party(trainerItem.id)).length >= MAX_PARTY) throw new Error(`O treinador já tem ${MAX_PARTY} Pokémon.`);
  const pkmn = parseExport(code, rules);
  const sp = await spriteFor(rules, pkmn);
  if (!sp) throw new Error(`Não achei o sprite de ${rules.name(pkmn)} na lista da extensão de imagens.`);
  const { tokenCells } = await import("./map.js?v=0.9.9");
  const cells = tokenCells(rules, pkmn);
  const dpi = await OBR.scene.grid.getDpi();
  // born already inside the pokéball: invisible, locked, small, under the trainer (players never see
  // it appear), linked to the trainer in the same go; "Liberar" brings it out at its real size
  const { buildImage } = SDK;
  const existing = await party(trainerItem.id);
  const used = new Set(existing.map((p) => getSheet(p).slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  const item = buildImage(
    { url: `${SPRITES}${encodeURIComponent(sp.f)}`, width: sp.w, height: sp.h, mime: sp.f.endsWith(".gif") ? "image/gif" : "image/png" },
    { dpi: sp.w / cells, offset: { x: sp.w / 2, y: sp.h / 2 } },
  )
    .name(rules.name(pkmn))
    .position({ ...trainerItem.position })
    .scale({ x: BALL_SCALE, y: BALL_SCALE })
    .layer("CHARACTER")
    .visible(false)
    .locked(true)
    .disableHit(true)
    .metadata({ [SHEET_KEY]: { pkmn, owner: t.owner, team: t.team, imported: Date.now(), trainer: trainerItem.id, slot, ball: { scale: { x: 1, y: 1 }, layer: "CHARACTER" }, battle: {} } })
    .build();
  await OBR.scene.items.addItems([item]);
  const [made] = await OBR.scene.items.getItems([item.id]);
  await pushLog({ kind: "note", attacker: trainerItem.name, text: `guardou ${made.name} na pokébola` });
  return made;
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
    dropIllusionDraft(s, dr); // back to its own look in the ball
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

// ------------------------------------------------------------------ Illusion (Zoroark)
// The trainer picks who it pretends to be (sheet.illusion = { id, name }). Coming out of the ball it
// takes that Pokémon's look (image, size, name); the real one is kept in battle.realLook. A hit that
// damages it (combat.js) or going back to the ball undoes it.
export const hasIllusion = (rules, sheet) => !!sheet && (sheet.battle?.ability ? sheet.battle.ability === "Illusion" : rules.abilities(sheet.pkmn).includes("Illusion"));
export async function applyIllusion(rules, item) {
  const s = getSheet(item);
  if (!hasIllusion(rules, s) || !s.illusion?.id || inBall(s) || s.battle?.realLook) return false;
  const [as] = await OBR.scene.items.getItems([s.illusion.id]);
  if (!as?.image) return false;
  const types = getSheet(as) ? rules.types(getSheet(as).pkmn) : null;
  await updateSheet(item.id, (sh, dr) => {
    sh.battle.realLook = { image: { ...dr.image }, grid: JSON.parse(JSON.stringify(dr.grid ?? {})), name: dr.name, types: null };
    sh.battle.fakeTypes = types;
    const sign = Math.sign(dr.scale?.x ?? 1) || 1;
    dr.image = { ...as.image };
    if (as.grid) dr.grid = JSON.parse(JSON.stringify(as.grid));
    const base = Math.abs(getSheet(as)?.ball?.scale?.x ?? as.scale?.x ?? 1);
    dr.scale = { x: sign * base, y: base };
    dr.name = as.name;
  });
  return true;
}
// undoes it (in an updateSheet draft); returns true when there was one
export function dropIllusionDraft(s, dr) {
  const real = s.battle?.realLook;
  if (!real) return false;
  dr.image = { ...real.image };
  if (real.grid && Object.keys(real.grid).length) dr.grid = real.grid;
  dr.name = real.name;
  delete s.battle.realLook;
  delete s.battle.fakeTypes;
  return true;
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
  // Healing Wish / Lunar Dance waiting on the trainer: the next one out comes back healed
  const wish = !!trainerOf(trainerItem)?.healingWish;
  if (wish) await OBR.scene.items.updateItems([trainerItem.id], (ds) => { for (const d0 of ds) { const t0 = { ...d0.metadata[TRAINER] }; delete t0.healingWish; d0.metadata[TRAINER] = t0; } });
  await updateSheet(pokemon.id, (s, dr) => {
    if (wish) {
      s.pkmn.hp.current = rules.maxHP(s.pkmn);
      for (const k of Object.keys(conditionsOf(s))) clearCondition(s, k, { grace: false });
    }
    dr.scale = { ...(s.ball?.scale ?? { x: 1, y: 1 }) };
    dr.visible = true;
    dr.locked = false;
    dr.disableHit = false;
    dr.position = { ...at };
    delete s.ball;
    s.battle.move = { used: 0, pos: { ...at } };
  });
  // Illusion: it comes out looking like the Pokémon chosen in the trainer's panel
  const fake = await applyIllusion(rules, (await OBR.scene.items.getItems([pokemon.id]))[0]).catch(() => false);
  if (!quiet) await pushLog({ kind: "note", attacker: trainerItem.name, text: `liberou ${fake ? getSheet(pokemon).illusion?.name ?? pokemon.name : pokemon.name}` });
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

  // Pursuit: enemies may hit the one leaving before it goes (the switch waits for their answer)
  if (combat && !fainted) {
    const { switchReactions } = await import("./protect.js?v=0.9.9");
    const ans = await switchReactions(rules, outItem, "out").catch(() => new Map());
    if ([...ans.values()].some((a) => a.status === "done")) await pushLog({ kind: "note", attacker: trainerItem.name, text: `${outItem.name} foi perseguido antes de voltar pra pokébola` });
    outItem = (await OBR.scene.items.getItems([outItem.id]))[0] ?? outItem;
  }
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
  // (the one coming in may be wearing an Illusion: its new name is the one everyone sees)
  const inNow = (await OBR.scene.items.getItems([inItem.id]))[0] ?? inItem;
  await pushLog({ kind: "note", attacker: trainerItem.name, text: `trocou ${outItem.name} por ${inNow.name}${why}${stages ? " — Baton Pass passou os estágios" : ""}${combat ? "; o novo rola iniciativa no começo da próxima rodada" : ""}` });
  await entryAbilities(rules, (await OBR.scene.items.getItems([inItem.id]))[0]);
  // Bolt Beak / Fishious Rend: enemies may hit the one that just came in
  if (combat) {
    const { switchReactions } = await import("./protect.js?v=0.9.9");
    await switchReactions(rules, (await OBR.scene.items.getItems([inItem.id]))[0], "in").catch(() => {});
  }
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
      if (abilitiesOf(rules, es).includes("Scrappy")) { notes.push(`${e.name} (Scrappy) é imune a Intimidate`); continue; }
      const n = d(20), total = n + (rules.saves(es.pkmn).WIS ?? 0);
      if (n === 1 || (n !== 20 && total < dc)) {
        // Clear Body, Hyper Cutter, Contrary, Defiant, Mirror Armor... (abilities.stageGuard)
        let g = null;
        await updateSheet(e.id, (x) => { g = stageGuard(rules, x, [{ stat: "Attack", delta: -1 }], { fromOther: true }); for (const st of g.list) addStage(x.pkmn, st.stat, st.delta); });
        notes.push(`${e.name} falhou (SAB ${total} vs CD ${dc})${g.list.length ? `: ${g.list.map((st) => `${st.stat === "Attack" ? "Ataque" : st.stat} ${st.delta > 0 ? "+" : ""}${st.delta}`).join(", ")}` : ""}${g.notes.length ? ` (${g.notes.join(", ")})` : ""}`);
      }
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
  // weather and terrain on entering (field.js)
  for (const [k, spec] of Object.entries(FIELD_ABILITIES)) if (ab.includes(k)) { const n = await startField({ ...spec, rounds: 5 }, { by: item.name }); if (n) notes.push(`${k}: ${n}`); }
  // Download: Ataque Especial +1 if the enemy's FOR+CON is higher than DES+SAB, otherwise Ataque +1
  if (ab.includes("Download") && enemies.length) {
    const e = (await near(enemies, 999))[0] ?? enemies[0];
    const a = rules.attributes(getSheet(e).pkmn);
    const stat = mod(a.STR) + mod(a.CON) > mod(a.DEX) + mod(a.WIS) ? "SpecialAttack" : "Attack";
    await updateSheet(item.id, (x) => addStage(x.pkmn, stat, 1));
    notes.push(`Download (analisou ${e.name}): ${stat === "Attack" ? "Ataque" : "Ataque Especial"} +1`);
  }
  // Moody: one stat +2 and another −1, at random
  if (ab.includes("Moody")) {
    const pool = ["Attack", "SpecialAttack", "Defense", "SpecialDefense", "Speed"];
    const up = pool[d(5) - 1];
    const rest = pool.filter((x) => x !== up);
    const down = rest[d(4) - 1];
    await updateSheet(item.id, (x) => { addStage(x.pkmn, up, 2); addStage(x.pkmn, down, -1); });
    notes.push(`Moody: ${up} +2, ${down} −1`);
  }
  // Trace: copies a random enemy's ability (some can't be copied)
  if (ab.includes("Trace") && enemies.length) {
    const NO = ["As One", "Battle Bond", "Comatose", "Commander", "Disguise", "Embody Aspect", "Flower Gift", "Forecast", "Gulp Missile", "Hunger Switch", "Ice Face",
      "Illusion", "Imposter", "Multitype", "Neutralizing Gas", "Poison Puppeteer", "Power Construct", "Power of Alchemy", "Protosynthesis", "Quark Drive", "Receiver",
      "RKS System", "Schooling", "Shields Down", "Stance Change", "Tera Shell", "Tera Shift", "Trace", "Zen Mode", "Zero to Hero"];
    const pool = enemies.map((e) => ({ e, a: rules.abilities(getSheet(e).pkmn).find((x) => !NO.includes(x)) })).filter((x) => x.a);
    if (pool.length) {
      const pick = pool[d(pool.length) - 1];
      await updateSheet(item.id, (x) => { x.battle.ability = pick.a; });
      notes.push(`Trace: copiou ${pick.a} de ${pick.e.name}`);
    }
  }
  // Costar: copies the stages of an ally within 15 m
  if (ab.includes("Costar")) {
    const f = (await near(friends, 15)).find((o) => Object.keys(getSheet(o).pkmn.stages ?? {}).length);
    if (f) { const st = { ...getSheet(f).pkmn.stages }; await updateSheet(item.id, (x) => { x.pkmn.stages = st; }); notes.push(`Costar: copiou os estágios de ${f.name}`); }
  }
  // Screen Cleaner: every Reflect / Light Screen / Aurora Veil ends
  if (ab.includes("Screen Cleaner")) {
    for (const team of ["jogadores", "inimigos", "neutros"]) await clearSide(team, ["reflect", "lightScreen", "auroraVeil"]);
    notes.push("Screen Cleaner: as telas acabaram");
  }
  // Supreme Overlord: fainted allies of its trainer (up to 5)
  if (ab.includes("Supreme Overlord") && s.trainer) {
    const down = (await party(s.trainer)).filter((p) => p.id !== item.id && getSheet(p).pkmn.hp.current <= 0).length;
    if (down) { await updateSheet(item.id, (x) => { x.battle.overlord = Math.min(5, down); }); notes.push(`Supreme Overlord: ${Math.min(5, down)} aliado(s) desmaiado(s)`); }
  }
  // the ones that only reveal something: a note for the table
  if (ab.includes("Anticipation")) {
    const scary = [];
    for (const e of enemies) {
      const ep = getSheet(e).pkmn;
      if (Object.keys(ep.moves ?? {}).some((n) => ["Fissure", "Horn Drill", "Guillotine", "Sheer Cold"].includes(n) || (rules.moveData(ep, n).damage && rules.effectiveness(rules.moves[n]?.Type, s.pkmn) > 1))) scary.push(e.name);
    }
    notes.push(`Anticipation: ${scary.length ? `estremeceu (${scary.join(", ")} tem Move perigoso)` : "nada perigoso"}`);
  }
  if (ab.includes("Forewarn") && enemies.length) {
    const e = enemies[0];
    const ep = getSheet(e).pkmn;
    const best = Object.keys(ep.moves ?? {}).map((n) => ({ n, m: rules.moveData(ep, n).damage })).filter((x) => x.m)
      .sort((a, b) => b.m.amount * b.m.dice - a.m.amount * a.m.dice)[0];
    if (best) notes.push(`Forewarn: ${e.name} conhece ${best.n}`);
  }
  if (ab.includes("Frisk") && enemies.length) {
    const e = enemies.find((o) => getSheet(o).pkmn.item);
    notes.push(`Frisk: ${e ? `${e.name} segura ${getSheet(e).pkmn.item}` : "ninguém segura item"}`);
  }
  for (const k of ["Imposter", "Curious Medicine", "Illusion"]) if (ab.includes(k)) notes.push(`${k}: confira o efeito ao entrar`);
  // Speed Boost doesn't work on the turn it comes in
  await updateSheet(item.id, (x) => { x.battle.justIn = true; });
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
