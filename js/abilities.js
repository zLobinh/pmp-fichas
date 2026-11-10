// Passive abilities ("Habilidades") from the PMP texts, as hooks the combat code calls:
//   attackMods  - the user's abilities on its own move (to-hit, crit, damage dice, type)
//   targetMods  - the target's abilities against that move (immunities, absorbing, damage cuts)
//   afterHit    - what happens once a hit lands (contact abilities, on-hit stages, KO triggers)
//   statusBlock - immunity to a condition (Limber, Insomnia, Safeguard, Misty Terrain...)
//   stageGuard  - stage changes coming from others (Clear Body, Contrary, Simple, Defiant, Mist...)
//   endTurn     - end of the Pokémon's own turn (Speed Boost, Shed Skin, Rain Dish, Poison Heal...)
//   initiative / movement - Swift Swim, Quick Feet, Slow Start, Stall...
// No imports from battle.js (it imports this file): plain data in, plain results out.
import { d } from "./rules.js?v=0.9.14";

const NONVOL = ["Burning", "Frozen", "Paralyzed", "Poisoned", "BadlyPoisoned", "Drowsy", "Asleep"];
const hasNonVol = (cond) => NONVOL.some((k) => cond?.[k]);

// ------------------------------------------------------------------ move families named in the texts
export const SLICING = ["Aerial Ace", "Air Cutter", "Air Slash", "Aqua Cutter", "Behemoth Blade", "Bitter Blade", "Ceaseless Edge",
  "Cross Poison", "Crush Claw", "Cut", "Dire Claw", "Dragon Claw", "Fury Cutter", "Kowtow Cleave", "Leaf Blade", "Metal Claw",
  "Mighty Cleave", "Night Slash", "Population Bomb", "Psycho Cut", "Psyblade", "Razor Leaf", "Razor Shell", "Sacred Sword",
  "Secret Sword", "Shadow Claw", "Slash", "Solar Blade", "Stone Axe", "Tachyon Cutter", "X-Scissor"];
export const BITING = ["Bite", "Crunch", "Fire Fang", "Fishious Rend", "Hyper Fang", "Ice Fang", "Jaw Lock", "Poison Fang", "Psychic Fangs", "Thunder Fang"];
const IRON_FIST_EXTRA = ["Double Iron Bash", "Hammer Arm", "Headlong Rush", "Ice Hammer", "Meteor Mash", "Plasma Fists", "Rage Fist", "Sky Uppercut", "Surging Strikes", "Wicked Blow"];
export const isPunch = (name) => (/Punch/.test(name) && name !== "Sucker Punch") || IRON_FIST_EXTRA.includes(name);
const BULLET_EXTRA = ["Acid Spray", "Aura Sphere", "Barrage", "Beak Blast", "Bullet Seed", "Focus Blast", "Octazooka", "Pollen Puff", "Rock Blast", "Rock Wrecker", "Searing Shot", "Zap Cannon"];
export const isBullet = (name) => /Ball|Bomb/.test(name) || BULLET_EXTRA.includes(name);
export const WIND = ["Aeroblast", "Air Cutter", "Bleakwind Storm", "Blizzard", "Fairy Wind", "Gust", "Heat Wave", "Hurricane", "Icy Wind",
  "Petal Blizzard", "Sandsear Storm", "Springtide Storm", "Tailwind", "Twister", "Whirlwind", "Wildbolt Storm"];
export const isPowder = (name) => /Powder|Spore/.test(name);
export const isSound = (raw) => /baseado em som/i.test(raw?.Description ?? "");
export const isRecoil = (name, raw) => /recuo/i.test(raw?.Description ?? "") || ["Axe Kick", "High Jump Kick", "Jump Kick", "Supercell Slam"].includes(name);
export const EXPLOSIONS = ["Self-Destruct", "Explosion", "Mind Blown", "Misty Explosion"];
const lvlHalf = (lvl) => Math.max(2, Math.ceil(lvl / 2));

// the abilities in effect: Trace/Mummy/Wandering Spirit write battle.ability; Neutralizing Gas on the
// field (ctx.gas) switches the others off
export function abilitiesOf(rules, sheet, ctx = {}) {
  if (!sheet?.pkmn) return [];
  const list = sheet.battle?.ability ? [sheet.battle.ability] : rules.abilities(sheet.pkmn);
  if (ctx.gas && !list.includes("Neutralizing Gas")) return [];
  return list;
}
const IGNORE_BREAK = new Set(["Prism Armor", "Shadow Shield", "Full Metal Body", "Shields Down", "Comatose"]);
const BREAKERS = ["Mold Breaker", "Teravolt", "Turboblaze"];

// ------------------------------------------------------------------ the user's side
// ctx: { field: fieldNow(), melee, stab, isLast, others: [{ sheet, dist, ally }], fx (moveEffects), level, prof }
export function attackMods(rules, aSheet, move, raw, ctx) {
  const ab = abilitiesOf(rules, aSheet, ctx);
  const has = (n) => ab.includes(n);
  const m = { acc: 0, dc: 0, crit: 0, groups: 0, keepHigh: false, keepLow: false, halfMore: false, double: false, halveFinal: false,
    flat: 0, type: null, ignoreResist: false, scrappy: false, sheer: false, noGuard: false, guts: false, noContact: false,
    unseenFist: false, moldBreaker: false, infiltrator: false, serene: false, notes: [] };
  const name = move.name;
  const type = move.type;
  const pk = aSheet.pkmn;
  const max = Math.max(1, rules.maxHP(pk));
  const hp = pk.hp.current;
  const cond = aSheet.battle?.cond ?? {};
  const damaging = !!move.damage;
  const field = ctx.field ?? {};
  const note = (t) => m.notes.push(t);
  const near = (abil, meters, { self = true, allyOnly = true } = {}) =>
    (self && has(abil)) || (ctx.others ?? []).some((o) => (!allyOnly || o.ally) && o.dist <= meters + 0.05 && abilitiesOf(rules, o.sheet, ctx).includes(abil));
  const anywhere = (abil) => has(abil) || (ctx.others ?? []).some((o) => abilitiesOf(rules, o.sheet, ctx).includes(abil));

  // to-hit and DC
  if (has("Compound Eyes")) { m.acc += 2; m.dc += 2; note("Compound Eyes +2"); }
  if (near("Victory Star", 999)) { m.acc += 1; m.dc += 1; note("Victory Star +1"); }
  if (has("Super Luck")) { m.crit += 3; note("Super Luck: margem de crítico +3"); }
  if (has("No Guard") && damaging) m.noGuard = true;
  if (BREAKERS.some(has)) m.moldBreaker = true;
  if (has("Infiltrator")) m.infiltrator = true;
  if (has("Unseen Fist") && ctx.melee) m.unseenFist = true;
  if (has("Long Reach")) m.noContact = true;
  if (has("Serene Grace")) m.serene = true;
  if (has("Scrappy") && ["Normal", "Fighting"].includes(type)) m.scrappy = true;
  if (has("Tinted Lens")) m.ignoreResist = true;

  // the move's type
  if (damaging && name !== "Struggle") {
    if (has("Normalize") && !["Hidden Power", "Judgment", "Multi-Attack", "Natural Gift", "Revelation Dance", "Techno Blast", "Weather Ball", "Terrain Pulse"].includes(name)) {
      m.type = "Normal"; m.keepHigh = true; note("Normalize: tipo Normal, dano rolado 2x");
    }
    for (const [abil, t] of [["Pixilate", "Fairy"], ["Refrigerate", "Ice"], ["Aerilate", "Flying"], ["Galvanize", "Electric"]]) {
      if (has(abil) && type === "Normal" && name !== "Terrain Pulse") { m.type = t; m.keepHigh = true; note(`${abil}: vira ${t}, dano rolado 2x`); }
    }
  }
  if (has("Liquid Voice") && isSound(raw)) { m.type = "Water"; note("Liquid Voice: tipo Água"); }
  const t = m.type ?? type;
  if (!damaging) return m;

  // +1 die per 2 dice ("Para cada 2 dados de dano, adicione +1 dado")
  const boost = (why) => { m.groups += 1; note(why); };
  if (has("Adaptability") && ctx.stab) { boost("Adaptability (no lugar do STAB)"); m.flat -= move.stab ?? 0; }
  for (const [abil, ty] of [["Blaze", "Fire"], ["Torrent", "Water"], ["Overgrow", "Grass"], ["Swarm", "Bug"]]) {
    if (has(abil) && t === ty && hp < max / 3) boost(`${abil}`);
  }
  if (has("Guts") && hasNonVol(cond) && ctx.melee) { boost("Guts"); m.guts = true; }
  if (has("Hustle") && ctx.melee) { boost("Hustle (−2 no acerto)"); m.acc -= 2; }
  if (has("Flare Boost") && cond.Burning && !ctx.melee) boost("Flare Boost");
  if (has("Toxic Boost") && (cond.Poisoned || cond.BadlyPoisoned) && ctx.melee) boost("Toxic Boost");
  if (has("Mega Launcher") && /Aura|Pulse/.test(name)) boost("Mega Launcher");
  if (has("Strong Jaw") && BITING.includes(name)) boost("Strong Jaw");
  if (has("Sharpness") && SLICING.includes(name)) boost("Sharpness");
  if (has("Steelworker") && t === "Steel") boost("Steelworker");
  if (t === "Steel") {
    const n = (has("Steely Spirit") ? 1 : 0) + (ctx.others ?? []).filter((o) => o.ally && o.dist <= 18.05 && abilitiesOf(rules, o.sheet, ctx).includes("Steely Spirit")).length;
    for (let i = 0; i < n; i++) boost("Steely Spirit");
  }
  if (has("Rocky Payload") && t === "Rock") boost("Rocky Payload");
  if (has("Technician")) {
    const top = raw?.Damage?.["17"];
    if (top && top.amount * top.dice_max <= 30) boost("Technician");
  }
  if (has("Flash Fire") && aSheet.battle?.flashFire && t === "Fire") boost("Flash Fire");
  if ((has("Plus") || has("Minus")) && !ctx.melee && (ctx.others ?? []).some((o) => o.ally && o.dist <= 9.05 && ["Plus", "Minus"].some((x) => abilitiesOf(rules, o.sheet, ctx).includes(x)))) boost("Plus/Minus");
  if (has("Solar Power") && field.weather === "sun" && !ctx.melee) boost("Solar Power");
  if (field.weather === "sun" && ctx.melee && near("Flower Gift", 6)) boost("Flower Gift");

  // roll the damage twice, keep the higher
  const high = (why) => { m.keepHigh = true; note(why); };
  if (has("Analytic") && ctx.isLast) high("Analytic (último na iniciativa)");
  if (has("Iron Fist") && isPunch(name)) high("Iron Fist");
  if (has("Tough Claws") && ctx.melee) high("Tough Claws");
  if (has("Reckless") && isRecoil(name, raw)) high("Reckless");
  if (has("Transistor") && t === "Electric") high("Transistor");
  if (has("Punk Rock") && isSound(raw)) high("Punk Rock");
  if (has("Sand Force") && field.weather === "sand" && ["Ground", "Rock", "Steel"].includes(t)) high("Sand Force");
  if (has("Protosynthesis") && (field.weather === "sun" || aSheet.battle?.booster)) high("Protosynthesis");
  if (has("Quark Drive") && (field.terrain === "electric" || aSheet.battle?.booster)) high("Quark Drive");
  if (near("Power Spot", 9, { self: false })) high("Power Spot de um aliado");
  if (!ctx.melee && near("Battery", 6, { self: false })) high("Battery de um aliado");
  for (const [abil, ty] of [["Dark Aura", "Dark"], ["Fairy Aura", "Fairy"]]) {
    if (t === ty && anywhere(abil)) {
      if (anywhere("Aura Break")) { m.keepLow = true; note(`${abil} revertida por Aura Break`); } else high(abil);
    }
  }
  if (has("Dragon's Maw") && t === "Dragon") { m.halfMore = true; note("Dragon's Maw"); }
  if (has("Water Bubble") && t === "Water") { m.double = true; note("Water Bubble: dados dobrados"); }
  if (aSheet.battle?.charged && t === "Electric") { m.double = true; note(`${aSheet.battle.charged}: dados dobrados`); }
  // Sheer Force: secondary effects off, damage rolled twice
  const fx = ctx.fx;
  const secondary = fx && (fx.natural || fx.statusHit || fx.statusFail || fx.fail?.length || fx.direct?.length || (fx.self?.some((s) => s.delta > 0)));
  if (has("Sheer Force") && secondary && !isRecoil(name, raw) && !(fx.self ?? []).some((s) => s.delta < 0)) { m.sheer = true; high("Sheer Force (sem efeitos secundários)"); }
  // the Ruin abilities of the others: Tablets (melee) / Vessel (ranged) weaken the attacks of whoever lacks them
  const others = (abil) => !has(abil) && (ctx.others ?? []).some((o) => o.dist <= 15.05 && abilitiesOf(rules, o.sheet, ctx).includes(abil));
  if (ctx.melee && others("Tablets of Ruin")) { m.keepLow = true; note("Tablets of Ruin: dano rolado 2x, fica o menor"); }
  if (!ctx.melee && others("Vessel of Ruin")) { m.keepLow = true; note("Vessel of Ruin: dano rolado 2x, fica o menor"); }

  // flat damage and halving
  if ((has("Huge Power") || has("Pure Power")) && ctx.melee) { m.flat += 2 * (ctx.prof ?? 2); note(`${has("Huge Power") ? "Huge Power" : "Pure Power"} +${2 * (ctx.prof ?? 2)}`); }
  if (has("Supreme Overlord") && aSheet.battle?.overlord) { const n = aSheet.battle.overlord * Math.max(1, Math.floor((ctx.prof ?? 2) / 2)); m.flat += n; note(`Supreme Overlord +${n}`); }
  if (has("Defeatist") && hp <= max / 2) { m.halveFinal = true; note("Defeatist: dano pela metade"); }
  if (has("Slow Start") && ctx.melee && (aSheet.battle?.slowStart ?? 0) < 5) { m.halveFinal = true; note("Slow Start: dano corpo a corpo pela metade"); }
  return m;
}

// ------------------------------------------------------------------ the target's side
// returns { immune, absorb: { heal, stages, flag }, mult, effAdj, red, noCritExtra, keepHigh, keepLow, sure,
//           acBonus, saveBonus, sturdy, firstHalf, disguise, bounce, notes }
export function targetMods(rules, aSheet, tSheet, move, raw, ctx) {
  const out = { immune: null, absorb: null, mult: 1, effAdj: null, red: 0, noCritExtra: false, keepHigh: false, keepLow: false,
    sure: false, acBonus: 0, saveBonus: 0, sturdy: false, firstHalf: false, disguise: null, bounce: false, redPoints: 0, notes: [] };
  if (!tSheet?.pkmn) return out;
  const breaker = !!ctx.moldBreaker && aSheet !== tSheet;
  const ab = abilitiesOf(rules, tSheet, ctx).filter((a) => !breaker || IGNORE_BREAK.has(a));
  const has = (n) => ab.includes(n);
  const t = ctx.type ?? move.type;
  const name = move.name;
  const damaging = !!move.damage;
  const statusMove = !damaging && move.rangeInfo?.kind !== "self";
  const pk = tSheet.pkmn;
  const max = Math.max(1, rules.maxHP(pk));
  const field = ctx.field ?? {};
  const fromOther = aSheet !== tSheet;
  const lvl = rules.level(pk);
  const absorb = (label, a) => { out.immune = label; out.absorb = a; };
  if (!fromOther) return out;

  if (has("No Guard")) out.sure = true;
  // immunities that also stop status moves of that type ("incluindo Moves de Status")
  if (t === "Ground" && has("Levitate") && name !== "Thousand Arrows") out.immune = "Levitate";
  if (t === "Ground" && has("Earth Eater")) absorb("Earth Eater", { heal: lvlHalf(lvl * 2) });
  if (t === "Fire" && has("Flash Fire")) absorb("Flash Fire (fortaleceu os Moves de Fogo dele)", { flag: "flashFire" });
  if (t === "Fire" && has("Well-Baked Body")) absorb("Well-Baked Body", { stages: [{ stat: "Defense", delta: 2 }] });
  if (t === "Electric" && has("Volt Absorb")) absorb("Volt Absorb", { heal: Math.max(2, lvl) });
  if (t === "Electric" && has("Motor Drive")) absorb("Motor Drive", { stages: [{ stat: "Speed", delta: 1 }] });
  if (t === "Electric" && has("Lightning Rod")) absorb("Lightning Rod", { stages: [{ stat: "SpecialAttack", delta: 1 }] });
  if (t === "Water" && has("Water Absorb")) absorb("Water Absorb", { heal: Math.max(2, lvl) });
  if (t === "Water" && has("Dry Skin")) absorb("Dry Skin", { heal: Math.max(2, lvl) });
  if (t === "Water" && has("Storm Drain")) absorb("Storm Drain", { stages: [{ stat: "SpecialAttack", delta: 1 }] });
  if (t === "Grass" && has("Sap Sipper")) absorb("Sap Sipper", { stages: [{ stat: "Attack", delta: 1 }] });
  if (WIND.includes(name) && has("Wind Rider")) absorb("Wind Rider", { stages: [{ stat: "Attack", delta: 1 }] });
  if (isBullet(name) && has("Bulletproof")) out.immune = "Bulletproof";
  if (isSound(raw) && has("Soundproof")) out.immune = "Soundproof";
  if (isPowder(name) && (has("Overcoat") || rules.types(pk).includes("Grass"))) out.immune = has("Overcoat") ? "Overcoat" : "tipo Grama (pó/esporo)";
  if (statusMove && has("Good as Gold")) out.immune = "Good as Gold";
  if (statusMove && has("Magic Bounce")) { out.immune = "Magic Bounce (devolvido ao atacante)"; out.bounce = true; }
  // Magic Coat (a reaction, protect.js): the same until its next turn
  if (statusMove && tSheet.battle?.protection?.kind === "bounce" && name !== "Magic Coat") { out.immune = "Magic Coat (devolvido ao atacante)"; out.bounce = true; }
  if (damaging && has("Telepathy") && ctx.ally) out.immune = "Telepathy (não sofre dano de aliados)";
  if (damaging && has("Wonder Guard") && (ctx.eff ?? 1) < 2) out.immune = "Wonder Guard (só super efetivo)";
  if (has("Armor Tail") || (ctx.others ?? []).some((o) => o.allyOfTarget && o.distToTarget <= 6.05 && abilitiesOf(rules, o.sheet, ctx).includes("Armor Tail"))) {
    if (ctx.priority > 0 && !ctx.ally) out.immune = "Armor Tail (Moves de prioridade)";
  }
  if (statusMove && has("Wonder Skin")) { out.acBonus += 5; out.saveBonus += 5; out.notes.push("Wonder Skin +5"); }
  if ((has("Sand Veil") && field.weather === "sand") || (has("Snow Cloak") && ["hail", "snow"].includes(field.weather))) {
    out.acBonus += 2; out.saveBonus += 2; out.notes.push(`${has("Sand Veil") ? "Sand Veil" : "Snow Cloak"} +2 na CA`);
  }
  if (!damaging) return out;

  // damage cuts
  const half = (why) => { out.mult *= 0.5; out.notes.push(why); };
  if (has("Thick Fat") && ["Fire", "Ice"].includes(t)) half("Thick Fat");
  if (has("Heatproof") && t === "Fire") half("Heatproof");
  if (has("Water Bubble") && t === "Fire") half("Water Bubble");
  if (has("Fluffy")) {
    if (ctx.melee && t !== "Fire") half("Fluffy");
    else if (!ctx.melee && t === "Fire") { out.mult *= 2; out.notes.push("Fluffy: fogo em dobro"); }
  }
  if (has("Fur Coat") && ctx.melee) half("Fur Coat");
  if (has("Ice Scales") && !ctx.melee) half("Ice Scales");
  if (has("Punk Rock") && isSound(raw)) half("Punk Rock");
  if (has("Purifying Salt") && t === "Ghost") half("Purifying Salt");
  if (has("Dry Skin") && t === "Fire") { out.keepHigh = true; out.notes.push("Dry Skin: fogo rolado 2x, fica o maior"); }
  if (["Filter", "Solid Rock", "Prism Armor"].some(has)) out.effAdj = (e) => (e > 1 ? e * 0.75 : e);
  if ((has("Multiscale") || has("Shadow Shield")) && pk.hp.current >= max) out.firstHalf = true;
  if (has("Sturdy") && pk.hp.current >= max) out.sturdy = true;
  if (has("Battle Armor") || has("Shell Armor")) out.noCritExtra = true;
  if (has("Marvel Scale") && hasNonVol(tSheet.battle?.cond) && ctx.melee) { out.red += 2 * rules.proficiency(pk); out.notes.push("Marvel Scale"); }
  if (has("Grass Pelt") && field.terrain === "grassy" && ctx.melee) { out.red += 2 * rules.proficiency(pk); out.notes.push("Grass Pelt"); }
  if (field.weather === "snow" && rules.types(pk).includes("Ice") && ctx.melee) { out.red += rules.proficiency(pk); out.notes.push("neve: −dano corpo a corpo"); }
  if (has("Disguise") && !tSheet.battle?.disguiseBroken) out.disguise = "Disguise";
  if (has("Ice Face") && ctx.melee && !tSheet.battle?.iceFaceBroken) out.disguise = "Ice Face";
  // Friend Guard of the target's allies: 1 reduction point each
  const fg = (ctx.others ?? []).filter((o) => o.allyOfTarget && o.distToTarget <= 4.55 && abilitiesOf(rules, o.sheet, ctx).includes("Friend Guard")).length;
  if (fg) { out.redPoints += fg; out.notes.push(`Friend Guard (${fg})`); }
  // the Ruin abilities: attacks against whoever lacks them roll twice, keep the higher
  const ruin = (abil) => !has(abil) && (ctx.others ?? []).some((o) => o.distToTarget <= 15.05 && abilitiesOf(rules, o.sheet, ctx).includes(abil))
    || (abilitiesOf(rules, aSheet, ctx).includes(abil) && !has(abil));
  if (!ctx.melee && ruin("Beads of Ruin")) { out.keepHigh = true; out.notes.push("Beads of Ruin"); }
  if (ctx.melee && ruin("Sword of Ruin")) { out.keepHigh = true; out.notes.push("Sword of Ruin"); }
  // Rivalry (the attacker's): same gender higher, opposite gender lower
  const aAb = abilitiesOf(rules, aSheet, ctx);
  const ga = aSheet.pkmn.gender, gt = pk.gender;
  if (aAb.includes("Rivalry") && ga && gt && ga !== "Genderless" && gt !== "Genderless") {
    if (ga === gt) { out.keepHigh = true; out.notes.push("Rivalry: mesmo gênero"); } else { out.keepLow = true; out.notes.push("Rivalry: gênero oposto"); }
  }
  // Merciless: a hit on a poisoned target is a critical hit
  if (aAb.includes("Merciless") && (tSheet.battle?.cond?.Poisoned || tSheet.battle?.cond?.BadlyPoisoned)) out.mercy = true;
  return out;
}

// ------------------------------------------------------------------ after a hit
// Returns ops: { target: [ops], attacker: [ops] } with op = { stages | give | damage | heal | flag | set | note }
// ctx: { melee, crit, noContact (Long Reach), hpBefore, hpAfter, ko, natural, attackHit, saveNat, type }
export function afterHit(rules, aSheet, tSheet, move, raw, ctx) {
  const T = [], A = [];
  const ab = abilitiesOf(rules, tSheet, ctx);
  const aab = abilitiesOf(rules, aSheet, ctx);
  const has = (n) => ab.includes(n);
  const ahas = (n) => aab.includes(n);
  const t = ctx.type ?? move.type;
  const pk = tSheet.pkmn;
  const max = Math.max(1, rules.maxHP(pk));
  const lvl = rules.level(pk);
  const contact = ctx.melee && !ctx.noContact;
  const roll = () => d(20);
  if (!move.damage || !ctx.damaged) return { T, A };

  // contact abilities of the target, each hit
  if (contact) {
    const chance = (abil, status) => { if (has(abil)) { const n = roll(); if (n >= 15) A.push({ give: status, note: `${abil} (${n})` }); } };
    chance("Static", "Paralyzed");
    chance("Flame Body", "Burning");
    chance("Poison Point", "Poisoned");
    if (has("Effect Spore") && !rules.types(aSheet.pkmn).includes("Grass") && !aab.includes("Overcoat")) {
      const n = roll();
      const st = n >= 19 ? "Drowsy" : n >= 17 ? "Paralyzed" : n >= 15 ? "Poisoned" : null;
      if (st) A.push({ give: st, note: `Effect Spore (${n})` });
    }
    if (has("Cute Charm") && aSheet.pkmn.gender && pk.gender && aSheet.pkmn.gender !== pk.gender && !aab.includes("Oblivious")) {
      const n = roll(); if (n >= 15) A.push({ give: "Infatuated", note: `Cute Charm (${n})` });
    }
    if ((has("Rough Skin") || has("Iron Barbs")) && !aab.includes("Magic Guard")) A.push({ damage: lvlHalf(lvl), note: has("Rough Skin") ? "Rough Skin" : "Iron Barbs" });
    if (has("Gooey") || has("Tangling Hair")) A.push({ stages: [{ stat: "Speed", delta: -1 }], note: has("Gooey") ? "Gooey" : "Tangling Hair" });
    if (has("Mummy") || has("Lingering Aroma")) A.push({ set: { ability: has("Mummy") ? "Mummy" : "Lingering Aroma" }, note: `virou ${has("Mummy") ? "Mummy" : "Lingering Aroma"}` });
    if (has("Wandering Spirit")) { A.push({ set: { ability: "Wandering Spirit" }, note: "trocou de habilidade (Wandering Spirit)" }); T.push({ set: { ability: aab[0] ?? null } }); }
    if (has("Perish Body") && !aSheet.battle?.perish) { A.push({ set: { perish: 3 }, note: "Perish Body: desmaia em 3 rodadas" }); if (!tSheet.battle?.perish) T.push({ set: { perish: 3 } }); }
    if (has("Weak Armor")) T.push({ stages: [{ stat: "Defense", delta: -1 }, { stat: "Speed", delta: 1 }], note: "Weak Armor" });
    if (has("Pickpocket")) T.push({ note: "Pickpocket: pode tentar roubar o item (reação)" });
    // the attacker's contact abilities
    if (ahas("Poison Touch")) { const n = roll(); if (n >= 15) T.push({ give: "Poisoned", note: `Poison Touch (${n})` }); }
    if (ahas("Stench") && ctx.natural >= 19) T.push({ give: "Stunned", note: "Stench" });
  }
  if (ahas("Toxic Chain") && ((ctx.natural ?? 0) >= 15 || (ctx.saveNat != null && ctx.saveNat <= 6))) T.push({ give: "BadlyPoisoned", note: "Toxic Chain" });
  if (has("Cursed Body")) { const n = roll(); if (n >= 15) A.push({ set: { disabled: { move: move.name, turns: 3 } }, note: `Cursed Body (${n}): ${move.name} bloqueado por 3 turnos` }); }

  // on-hit stages of the target
  const up = (abil, stages, when = true) => { if (has(abil) && when) T.push({ stages, note: abil }); };
  up("Stamina", [{ stat: "Defense", delta: 1 }]);
  up("Justified", [{ stat: "Attack", delta: 1 }], t === "Dark");
  up("Rattled", [{ stat: "Speed", delta: 1 }], ["Dark", "Bug", "Ghost"].includes(t));
  up("Water Compaction", [{ stat: "Defense", delta: 2 }], t === "Water");
  up("Steam Engine", [{ stat: "Speed", delta: 6 }], ["Fire", "Water"].includes(t));
  up("Thermal Exchange", [{ stat: "Attack", delta: 1 }], t === "Fire");
  up("Anger Point", [{ stat: "Attack", delta: 6 }], !!ctx.crit);
  const crossed = ctx.hpBefore > max / 2 && ctx.hpAfter <= max / 2 && ctx.hpAfter > 0;
  up("Anger Shell", [{ stat: "Attack", delta: 1 }, { stat: "SpecialAttack", delta: 1 }, { stat: "Speed", delta: 1 }, { stat: "Defense", delta: -1 }, { stat: "SpecialDefense", delta: -1 }], crossed);
  up("Berserk", [{ stat: "SpecialAttack", delta: 1 }], crossed);
  if (has("Electromorphosis")) T.push({ set: { charged: "Electromorphosis" }, note: "Electromorphosis: próximo Move Elétrico com dados dobrados" });
  if (has("Wind Power") && WIND.includes(move.name)) T.push({ set: { charged: "Wind Power" }, note: "Wind Power: próximo Move Elétrico com dados dobrados" });
  if ((has("Emergency Exit") || has("Wimp Out")) && crossed) T.push({ set: { mustSwitch: { by: has("Emergency Exit") ? "Emergency Exit" : "Wimp Out", free: true } }, note: `${has("Emergency Exit") ? "Emergency Exit" : "Wimp Out"}: tem que trocar` });
  if (has("Seed Sower")) T.push({ field: { terrain: "grassy" }, note: "Seed Sower" });
  if (has("Sand Spit")) T.push({ field: { weather: "sand" }, note: "Sand Spit" });
  if (has("Cotton Down")) T.push({ note: "Cotton Down: criaturas a até 6 m fazem TR de CON ou −1 Velocidade" });
  if (has("Color Change") && t !== "Typeless") T.push({ note: `Color Change: virou tipo ${t}` });
  if (has("Disguise") && !tSheet.battle?.disguiseBroken) T.push({ set: { disguiseBroken: true } });

  // knock-outs
  if (ctx.ko) {
    if (has("Aftermath") && ctx.melee && !aab.includes("Magic Guard")) A.push({ damage: Math.max(2, rules.level(aSheet.pkmn)), note: "Aftermath" });
    if (has("Innards Out")) A.push({ damage: ctx.hpBefore, note: "Innards Out" });
    if (ahas("Moxie") || ahas("Chilling Neigh")) A.push({ stages: [{ stat: "Attack", delta: 1 }], note: ahas("Moxie") ? "Moxie" : "Chilling Neigh" });
    if (ahas("Grim Neigh")) A.push({ stages: [{ stat: "SpecialAttack", delta: 1 }], note: "Grim Neigh" });
    if (ahas("Beast Boost")) A.push({ note: "Beast Boost: +2 no maior atributo (até voltar pra pokébola)" });
  }
  return { T, A };
}

// ------------------------------------------------------------------ conditions
// ctx: { field: fieldNow(), grounded, team, source: { abilities, infiltrator, secondary }, fromOther }
export function statusBlock(rules, sheet, key, ctx = {}) {
  const ab = abilitiesOf(rules, sheet, ctx);
  const has = (n) => ab.includes(n);
  const nonVol = NONVOL.includes(key);
  const field = ctx.field ?? {};
  const max = Math.max(1, rules.maxHP(sheet.pkmn));
  const by = (n, keys) => has(n) && keys.includes(key) ? n : null;
  const r = by("Immunity", ["Poisoned", "BadlyPoisoned"]) ?? by("Limber", ["Paralyzed"]) ?? by("Insomnia", ["Asleep", "Drowsy"])
    ?? by("Vital Spirit", ["Asleep", "Drowsy"]) ?? by("Sweet Veil", ["Asleep", "Drowsy"]) ?? by("Magma Armor", ["Frozen"])
    ?? by("Water Veil", ["Burning"]) ?? by("Water Bubble", ["Burning"]) ?? by("Thermal Exchange", ["Burning"])
    ?? by("Own Tempo", ["Confused"]) ?? by("Oblivious", ["Infatuated"]) ?? by("Inner Focus", ["Stunned"]);
  if (r) return r;
  if (nonVol && (has("Purifying Salt") || has("Comatose"))) return has("Comatose") ? "Comatose" : "Purifying Salt";
  if (nonVol && has("Leaf Guard") && field.weather === "sun") return "Leaf Guard (sol)";
  if (has("Shields Down") && sheet.pkmn.hp.current >= max / 2) return "Shields Down (Forma Meteoro)";
  if (nonVol && has("Flower Veil") && rules.types(sheet.pkmn).includes("Grass")) return "Flower Veil";
  if (ctx.fromOther && ctx.source?.secondary && has("Shield Dust")) return "Shield Dust";
  if (ctx.fromOther && sheet.battle?.sub) return "Substitute";
  if (ctx.fromOther && !ctx.source?.infiltrator && ctx.team && field.sides?.[ctx.team]?.safeguard) return "Safeguard";
  if (ctx.grounded && field.terrain === "misty" && nonVol) return "Misty Terrain";
  if (ctx.grounded && field.terrain === "electric" && ["Asleep", "Drowsy"].includes(key)) return "Electric Terrain";
  return null;
}
// a condition was just given: abilities that react (Synchronize, Steadfast, Tangled Feet)
export function onCondition(rules, sheet, key) {
  const ab = abilitiesOf(rules, sheet);
  const out = { stages: [], back: null, notes: [] };
  if (ab.includes("Steadfast") && key === "Stunned") { out.stages.push({ stat: "Speed", delta: 1 }); out.notes.push("Steadfast"); }
  if (ab.includes("Tangled Feet") && key === "Confused") { out.stages.push({ stat: "Evasion", delta: 1 }); out.notes.push("Tangled Feet"); }
  if (ab.includes("Synchronize") && ["Burning", "Paralyzed", "Poisoned", "BadlyPoisoned"].includes(key)) out.back = key;
  return out;
}

// ------------------------------------------------------------------ stages coming from others
// returns { list: [{stat, delta}] to apply on the target, reflect: [...] (Mirror Armor), extra notes }
export function stageGuard(rules, sheet, list, ctx = {}) {
  const ab = abilitiesOf(rules, sheet, ctx);
  const has = (n) => ab.includes(n);
  const out = { list: [], reflect: [], notes: [] };
  const field = ctx.field ?? {};
  let dropped = false;
  for (const st0 of list) {
    let delta = st0.delta;
    if (has("Contrary")) delta = -delta;
    if (has("Simple")) delta *= 2;
    if (delta < 0 && ctx.fromOther) {
      const stop = (has("Clear Body") || has("White Smoke") || has("Full Metal Body")) ? "Clear Body"
        : has("Hyper Cutter") && st0.stat === "Attack" ? "Hyper Cutter"
        : has("Big Pecks") && st0.stat === "Defense" ? "Big Pecks"
        : (has("Keen Eye") || has("Illuminate")) && st0.stat === "Accuracy" ? (has("Keen Eye") ? "Keen Eye" : "Illuminate")
        : has("Flower Veil") && rules.types(sheet.pkmn).includes("Grass") ? "Flower Veil"
        : sheet.battle?.sub ? "Substitute"
        : !ctx.infiltrator && ctx.team && field.sides?.[ctx.team]?.mist ? "Mist" : null;
      if (stop) { out.notes.push(`${stop} impediu ${st0.stat} ${delta}`); continue; }
      if (has("Mirror Armor")) { out.reflect.push({ stat: st0.stat, delta }); out.notes.push("Mirror Armor devolveu"); continue; }
      dropped = true;
    }
    out.list.push({ stat: st0.stat, delta });
  }
  if (dropped && ctx.fromOther) {
    if (has("Defiant")) { out.list.push({ stat: "Attack", delta: 2 }); out.notes.push("Defiant: Ataque +2"); }
    if (has("Competitive")) { out.list.push({ stat: "SpecialAttack", delta: 2 }); out.notes.push("Competitive: Ataque Especial +2"); }
  }
  return out;
}

// ------------------------------------------------------------------ end of its own turn
// mutates the sheet; ctx: { field, grounded, badDreams }. Returns notes.
export function endTurnAbilities(rules, sheet, ctx, { addStage, clearCondition, heal, hurt }) {
  const ab = abilitiesOf(rules, sheet, ctx);
  const has = (n) => ab.includes(n);
  const notes = [];
  const pk = sheet.pkmn;
  const cond = sheet.battle?.cond ?? {};
  const field = ctx.field ?? {};
  const lvl = rules.level(pk), prof = rules.proficiency(pk);
  if (pk.hp.current <= 0) return notes;
  if (has("Speed Boost") && !sheet.battle?.justIn) { addStage(pk, "Speed", 1); notes.push("Speed Boost: Velocidade +1"); }
  if (has("Shed Skin") && hasNonVol(cond)) {
    const n = d(20);
    if (n >= 15) { for (const k of NONVOL) if (cond[k]) clearCondition(sheet, k); notes.push(`Shed Skin (${n}): curado`); }
  }
  if (has("Hydration") && field.weather === "rain" && hasNonVol(cond)) { for (const k of NONVOL) if (cond[k]) clearCondition(sheet, k); notes.push("Hydration: curado na chuva"); }
  const cure = (abil, keys) => { if (has(abil)) for (const k of keys) if (cond[k] && clearCondition(sheet, k)) notes.push(`${abil}: curou ${k}`); };
  cure("Immunity", ["Poisoned", "BadlyPoisoned"]); cure("Limber", ["Paralyzed"]); cure("Insomnia", ["Asleep", "Drowsy"]);
  cure("Vital Spirit", ["Asleep", "Drowsy"]); cure("Magma Armor", ["Frozen"]); cure("Water Veil", ["Burning"]); cure("Water Bubble", ["Burning"]);
  cure("Thermal Exchange", ["Burning"]); cure("Own Tempo", ["Confused"]); cure("Oblivious", ["Infatuated"]);
  if (has("Rain Dish") && field.weather === "rain") { heal(prof); notes.push(`Rain Dish +${prof} HP`); }
  if (has("Ice Body") && field.weather === "hail") { heal(prof); notes.push(`Ice Body +${prof} HP`); }
  if (has("Dry Skin") && field.weather === "rain") { heal(lvlHalf(lvl)); notes.push(`Dry Skin +${lvlHalf(lvl)} HP`); }
  if (has("Dry Skin") && field.weather === "sun" && !has("Magic Guard")) { hurt(lvlHalf(lvl)); notes.push(`Dry Skin no sol −${lvlHalf(lvl)} HP`); }
  if (has("Solar Power") && field.weather === "sun" && !has("Magic Guard")) { hurt(lvlHalf(lvl)); notes.push(`Solar Power −${lvlHalf(lvl)} HP`); }
  if (ctx.badDreams && (cond.Asleep || has("Comatose")) && !has("Magic Guard")) { hurt(lvlHalf(lvl)); notes.push(`Bad Dreams −${lvlHalf(lvl)} HP`); }
  if (has("Slow Start")) sheet.battle.slowStart = (sheet.battle.slowStart ?? 0) + 1;
  if (has("Truant")) { sheet.battle.truantLazy = !sheet.battle.truantLazy; if (sheet.battle.truantLazy) notes.push("Truant: no próximo turno não usa Moves"); }
  if (has("Power Construct") && pk.hp.current < rules.maxHP(pk) / 2) notes.push("Power Construct: pode virar a Forma Completa");
  if (has("Zen Mode") && pk.hp.current < rules.maxHP(pk) / 2) notes.push("Zen Mode: entra no Modo Zen");
  delete sheet.battle.justIn;
  return notes;
}
// condition damage at the end of the turn: Magic Guard, Poison Heal, Heatproof
export function conditionDamage(rules, sheet, key, base) {
  const ab = abilitiesOf(rules, sheet);
  if (ab.includes("Magic Guard")) return { amount: 0, note: "Magic Guard: sem dano" };
  if (ab.includes("Poison Heal") && (key === "Poisoned" || key === "BadlyPoisoned")) return { heal: Math.max(2, Math.ceil(rules.level(sheet.pkmn) / 2)), note: "Poison Heal" };
  if (ab.includes("Heatproof") && key === "Burning") return { amount: Math.floor(rules.proficiency(sheet.pkmn) / 2), note: "Heatproof" };
  return { amount: base };
}

// ------------------------------------------------------------------ initiative and movement
export function initiativeMods(rules, sheet, field = {}) {
  const ab = abilitiesOf(rules, sheet);
  const has = (n) => ab.includes(n);
  const prof = rules.proficiency(sheet.pkmn);
  const cond = sheet.battle?.cond ?? {};
  const out = { add: 0, mult: 1, stall: has("Stall"), ignoreParalysis: false, notes: [] };
  const w = field.weather;
  const fast = (abil, when) => { if (has(abil) && when) { out.add += 2 * prof; out.notes.push(abil); } };
  fast("Swift Swim", w === "rain"); fast("Chlorophyll", w === "sun"); fast("Sand Rush", w === "sand"); fast("Slush Rush", ["hail", "snow"].includes(w));
  fast("Unburden", !!sheet.battle?.unburden);
  if (has("Quick Feet") && hasNonVol(cond)) { out.mult *= 1.5; out.ignoreParalysis = true; out.notes.push("Quick Feet"); }
  if (has("Slow Start") && (sheet.battle?.slowStart ?? 0) < 5) { out.mult *= 0.5; out.notes.push("Slow Start"); }
  return out;
}
export function movementMods(rules, sheet, field = {}, team = null) {
  const ab = abilitiesOf(rules, sheet);
  const has = (n) => ab.includes(n);
  const cond = sheet.battle?.cond ?? {};
  const out = { mult: 1, add: 0, ignoreParalysis: false, why: [] };
  const w = field.weather;
  const dbl = (abil, when) => { if (has(abil) && when) { out.mult *= 2; out.why.push(abil); } };
  dbl("Swift Swim", w === "rain"); dbl("Chlorophyll", w === "sun"); dbl("Sand Rush", w === "sand"); dbl("Slush Rush", ["hail", "snow"].includes(w));
  dbl("Unburden", !!sheet.battle?.unburden);
  if (team && field.sides?.[team]?.tailwind) { out.mult *= 2; out.why.push("Tailwind"); }
  if (has("Quick Feet") && hasNonVol(cond)) { out.add += 1.5; out.ignoreParalysis = true; out.why.push("Quick Feet"); }
  if (has("Slow Start") && (sheet.battle?.slowStart ?? 0) < 5) { out.mult *= 0.5; out.why.push("Slow Start"); }
  return out;
}

// ------------------------------------------------------------------ action economy
// moves that may go as a bonus action: Prankster (status), Gale Wings (Flying at full HP), Triage (healing)
export function bonusAllowed(rules, sheet, move, raw) {
  const ab = abilitiesOf(rules, sheet);
  const status = !raw?.Damage && !raw?.atk && !raw?.Save;
  if (ab.includes("Prankster") && status) return { by: "Prankster" };
  if (ab.includes("Gale Wings") && raw?.Type === "Flying" && sheet.pkmn.hp.current >= rules.maxHP(sheet.pkmn)) return { by: "Gale Wings" };
  if (ab.includes("Triage") && /(recupera|cura|metade do dano causado)/i.test(raw?.Description ?? "")) return { by: "Triage", losesNextAction: true };
  return null;
}
