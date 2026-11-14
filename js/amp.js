// Pontos de Amplificação / Redução de dano, igual ao app (PMP 1.98, livro novo):
// pokedex/items.lua M.amplification, pokedex/abilitydex.lua M.amplification e pokemon.lua
// get_damage_mod_stab. Tudo vira PONTOS que se somam (STAB = 1 ponto; Adaptability troca esse ponto
// pelos 2 dela), e só depois os pontos viram efeito:
//   meio ponto   -> + metade da proficiência (mínimo 1), sempre (1,5 = rerrolagem + ½ prof.)
//   ponto ímpar  -> rola os dados 2x e fica com o maior (rerrolagem)
//   cada 2       -> +1 dado a cada 2 dados (sobrou 1 dado: +¼ do dado, pra cima)
// Redução: 0,5 -> − metade da proficiência; ímpar -> rola 2x e fica com o menor; cada 2 -> dano final ÷2.
// Life Orb ("+1 dado a cada 3; sobrou dado, rerrola") conta 1 ponto, mas os dados seguem a regra dela
// e vêm ANTES dos outros pontos. "Dobra / corta pela metade os dados" (Water Bubble, Charge, Sunny Day na
// Água...) não é ponto: multiplica os dados DEPOIS da Amplificação (passo 7, igual ao crítico).
//
// Fonte de cada entrada: points, reduction, types, range ("melee"/"ranged"), punch, bite, moves,
// sound, recoil, nameContains, typeOverride, stab, technician, condition, diceMult, perThree,
// species (só nessas espécies), when (ativável: a extensão decide pelo campo/aliados/estado; o
// "ATIVAR" do app, pkmn.activated_effects, também liga).
import { SLICING, BITING, isSound, isRecoil } from "./abilities.js?v=0.9.23";

const TYPE_ITEMS = {
  "Black Belt": "Fighting", "Black Glasses": "Dark", Charcoal: "Fire", "Dragon Fang": "Dragon", "Fairy Feather": "Fairy",
  "Hard Stone": "Rock", Magnet: "Electric", "Metal Coat": "Steel", "Miracle Seed": "Grass", "Mystic Water": "Water",
  "Never-Melt Ice": "Ice", "Poison Barb": "Poison", "Sharp Beak": "Flying", "Silk Scarf": "Normal", "Silver Powder": "Bug",
  "Soft Sand": "Ground", "Spell Tag": "Ghost", "Twisted Spoon": "Psychic",
};
export const ITEMS = {
  ...Object.fromEntries(Object.entries(TYPE_ITEMS).map(([k, t]) => [k, { points: 1, types: [t] }])),
  "Adamant Orb": { points: 1, types: ["Steel", "Dragon"], species: ["Dialga"] },
  "Arceus Plate": { points: 1, stab: true, species: ["Arceus"] },
  "Lustrous Orb": { points: 1, types: ["Water", "Dragon"], species: ["Palkia"] },
  "Griseous Orb": { points: 1, types: ["Dragon", "Ghost"], species: ["Giratina"] },
  "Soul Dew": { points: 1, types: ["Psychic", "Dragon"], species: ["Latios", "Latias"] },
  "Choice Band": { points: 2, range: "melee" },
  "Choice Specs": { points: 2, range: "ranged" },
  "Muscle Band": { points: 0.5, range: "melee" },
  "Wise Glasses": { points: 0.5, range: "ranged" },
  "Life Orb": { points: 1, perThree: true },
  "Deep Sea Tooth": { points: 0, diceMult: 2, range: "ranged", species: ["Clamperl"] },
};
// Gemas: consumíveis, só com o ATIVAR do app (ou battle.gem na extensão)
for (const t of ["Bug", "Dark", "Dragon", "Electric", "Fairy", "Fighting", "Fire", "Flying", "Ghost", "Grass", "Ground", "Ice", "Normal", "Poison", "Psychic", "Rock", "Steel", "Water"]) {
  ITEMS[`${t} Gem`] = { points: 1, types: [t], when: "gem" };
}

export const ABILITIES = {
  Hustle: { points: 2, range: "melee" },
  "Tough Claws": { points: 1, range: "melee" },
  Transistor: { points: 1, types: ["Electric"] },
  Steelworker: { points: 2, types: ["Steel"] },
  "Rocky Payload": { points: 2, types: ["Rock"] },
  "Fire Mane": { points: 2, types: ["Fire"] },
  "Dragon's Maw": { points: 2, types: ["Dragon"] },
  "Iron Fist": { points: 1, punch: true },
  "Strong Jaw": { points: 2, bite: true },
  "Mega Launcher": { points: 2, nameContains: ["Aura", "Pulse"] },
  Technician: { points: 2, technician: true },
  Adaptability: { points: 2, stab: true },
  Pixilate: { points: 1, typeOverride: true }, Aerilate: { points: 1, typeOverride: true }, Refrigerate: { points: 1, typeOverride: true },
  Galvanize: { points: 1, typeOverride: true }, Dragonize: { points: 1, typeOverride: true }, Normalize: { points: 1, typeOverride: true },
  Guts: { points: 2, range: "melee", condition: "any_status" },
  "Toxic Boost": { points: 2, range: "melee", condition: "poisoned" },
  "Flare Boost": { points: 2, range: "ranged", condition: "burning" },
  Blaze: { points: 2, types: ["Fire"], condition: "low_hp" },
  Overgrow: { points: 2, types: ["Grass"], condition: "low_hp" },
  Torrent: { points: 2, types: ["Water"], condition: "low_hp" },
  Swarm: { points: 2, types: ["Bug"], condition: "low_hp" },
  Sharpness: { points: 2, slicing: true },
  "Steely Spirit": { points: 2, types: ["Steel"] },
  "Punk Rock": { points: 1, sound: true },
  Reckless: { points: 1, recoil: true },
  "Mega Sol": [{ points: 2, types: ["Fire"] }, { points: 0, diceMult: 0.5, types: ["Water"] }],
  "Water Bubble": { points: 0, diceMult: 2, types: ["Water"] },
  Electromorphosis: { points: 0, diceMult: 2, types: ["Electric"], when: "charged" },
  "Wind Power": { points: 0, diceMult: 2, types: ["Electric"], when: "charged" },
  Defeatist: { points: 2, reduction: true, condition: "half_hp" },
  "Slow Start": { points: 2, reduction: true, range: "melee", when: "slowStart" },
  // ativáveis: a extensão sabe quando valem (campo, aliados, ordem da iniciativa...)
  "Flash Fire": { points: 2, types: ["Fire"], when: "flashFire" },
  "Sand Force": { points: 1, types: ["Ground", "Rock", "Steel"], when: "sand" },
  "Solar Power": { points: 2, range: "ranged", when: "sun" },
  "Flower Gift": { points: 2, range: "melee", when: "sun" },
  Plus: { points: 2, range: "ranged", when: "plusMinus" },
  Minus: { points: 2, range: "ranged", when: "plusMinus" },
  "Dark Aura": { points: 1, types: ["Dark"], when: "always" },
  "Fairy Aura": { points: 1, types: ["Fairy"], when: "always" },
  Analytic: { points: 1, when: "last" },
  Neuroforce: { points: 1, when: "manual" },
  Rivalry: { points: 1, when: "manual" },
  Protosynthesis: { points: 1, when: "proto" },
  "Quark Drive": { points: 1, when: "quark" },
  "Sheer Force": { points: 1, when: "sheer" },
};

// moves de campo: clima / terreno (pokedex/moves.lua amplification)
const SOLAR = ["Solar Beam", "Solar Blade"];
export const FIELD_AMP = {
  sun: [{ points: 2, types: ["Fire"], label: "Sol (Fogo)" }, { points: 0, diceMult: 0.5, types: ["Water"], label: "Sol (Água, dados pela metade)" }],
  rain: [{ points: 2, types: ["Water"], label: "Chuva (Água)" }, { points: 0, diceMult: 0.5, types: ["Fire"], label: "Chuva (Fogo, dados pela metade)" },
    { points: 0, diceMult: 0.5, moves: SOLAR, label: "Chuva (Solar Beam/Blade, dados pela metade)" }],
  sand: [{ points: 2, reduction: true, moves: SOLAR, label: "Tempestade de areia (Solar Beam/Blade, Redução)" }],
  hail: [{ points: 2, reduction: true, moves: SOLAR, label: "Granizo (Solar Beam/Blade, Redução)" }],
  snow: [{ points: 2, reduction: true, moves: SOLAR, label: "Neve (Solar Beam/Blade, Redução)" }],
  electric: [{ points: 1, types: ["Electric"], label: "Electric Terrain (Elétrico)" }],
  psychic: [{ points: 1, types: ["Psychic"], label: "Psychic Terrain (Psíquico)" }],
  grassy: [{ points: 1, types: ["Grass"], label: "Grassy Terrain (Grama)" },
    { points: 2, reduction: true, moves: ["Earthquake", "Magnitude", "Bulldoze"], label: "Grassy Terrain (Earthquake/Magnitude/Bulldoze, Redução)" }],
  misty: [{ points: 2, reduction: true, types: ["Dragon"], label: "Misty Terrain (Dragão, Redução)" }],
};

const NONVOL = ["Burning", "Frozen", "Paralyzed", "Poisoned", "BadlyPoisoned", "Asleep"];
const isPunchApp = (name) => !!name && name !== "Sucker Punch" && (/Punch/.test(name) || name === "Sky Uppercut"
  || ["Double Iron Bash", "Hammer Arm", "Headlong Rush", "Ice Hammer", "Meteor Mash", "Plasma Fists", "Rage Fist", "Surging Strikes", "Wicked Blow"].includes(name));
const list = (e) => (Array.isArray(e) ? e : e ? [e] : []);
const speciesOk = (rules, pkmn, allowed) => !allowed || allowed.some((s) => (pkmn.species?.current ?? "").startsWith(s));

function conditionMet(rules, sheet, c) {
  if (!c) return true;
  const cond = sheet.battle?.cond ?? {};
  const max = Math.max(1, rules.maxHP(sheet.pkmn)), hp = sheet.pkmn.hp.current;
  if (c === "any_status") return NONVOL.some((k) => cond[k]);
  if (c === "poisoned") return !!(cond.Poisoned || cond.BadlyPoisoned);
  if (c === "burning") return !!cond.Burning;
  if (c === "low_hp") return hp < max / 3;
  if (c === "half_hp") return hp <= max / 2;
  return false;
}

// does this source count for this move?
function applies(rules, sheet, e, ctx) {
  if (!conditionMet(rules, sheet, e.condition)) return false;
  if (e.types && !e.types.includes(ctx.type)) return false;
  if (e.range === "melee" && !ctx.melee) return false;
  if (e.range === "ranged" && ctx.melee) return false;
  if (e.punch && !isPunchApp(ctx.name)) return false;
  if (e.bite && !BITING.includes(ctx.name)) return false;
  if (e.moves && !e.moves.includes(ctx.name)) return false;
  if (e.slicing && !SLICING.includes(ctx.name)) return false;
  if (e.sound && !isSound(ctx.raw)) return false;
  if (e.recoil && !isRecoil(ctx.name, ctx.raw)) return false;
  if (e.nameContains && !e.nameContains.some((w) => (ctx.name ?? "").includes(w))) return false;
  if (e.typeOverride && !ctx.typeOverridden) return false;
  if (e.stab && !ctx.stab) return false;
  if (e.technician) {
    const top = ctx.raw?.Damage?.["17"];
    if (!(top && top.amount && top.dice_max && top.amount * top.dice_max <= 30)) return false;
  }
  return true;
}

// the attacker's sources for this move: { amp, red, diceMult, perThree, notes }
// ctx: { name, raw, type (after Pixilate & co.), melee, stab, typeOverridden, field, grounded, isLast,
//        active(when, name) -> bool (the context-dependent ones: weather, allies, ...) }
export function moveAmp(rules, sheet, abilities, ctx) {
  const out = { amp: 0, red: 0, diceMult: 1, perThree: 0, notes: [] };
  const pk = sheet.pkmn;
  const manual = (n) => !!pk.activated_effects?.[n];
  const add = (e, label) => {
    if (!applies(rules, sheet, e, ctx)) return;
    if (e.diceMult) out.diceMult *= e.diceMult;
    if (e.reduction) out.red += e.points;
    else { out.amp += e.points; if (e.perThree) out.perThree++; }
    out.notes.push(e.label ?? label);
  };
  const item = !sheet.battle?.itemLost ? pk.item : null;
  const ie = item && ITEMS[item];
  if (ie && speciesOk(rules, pk, ie.species) && (!ie.when || manual(item) || (ie.when === "gem" && sheet.battle?.gem === item))) {
    add(ie, `${item}${ie.points ? ` (${String(ie.points).replace(".", ",")} pt)` : ""}`);
  }
  for (const ab of abilities) {
    for (const e of list(ABILITIES[ab])) {
      if (e.when && !manual(ab) && !ctx.active(e.when, ab)) continue;
      add(e, e.diceMult ? `${ab} (dados ×${String(e.diceMult).replace(".", ",")})` : e.reduction ? `${ab} (Redução ${e.points})` : `${ab} (${e.points} pt)`);
    }
  }
  // Mega Evolução ativa: 1 ponto em todos os Moves (app 1.98)
  if (pk.is_mega) { out.amp += 1; out.notes.push("Mega Evolução (1 pt)"); }
  // STAB: 1 ponto (Adaptability troca pelos 2 dela, acima)
  if (ctx.stab && !abilities.includes("Adaptability")) out.amp += 1;
  // clima e terreno onde o atacante está (os terrenos só pra quem está no chão)
  const f = ctx.field ?? {};
  for (const e of FIELD_AMP[f.weather] ?? []) add(e);
  if (ctx.grounded || f.terrain === "misty") for (const e of FIELD_AMP[f.terrain] ?? []) add(e);
  return out;
}

// pontos -> o que fazem (pokemon.lua get_damage_points_summary)
export function summary(amp, red) {
  const clamp = (v) => Math.max(0, Math.min(20, Math.round((v || 0) * 2) / 2));
  amp = clamp(amp); red = clamp(red);
  const a = Math.floor(amp), r = Math.floor(red);
  // the half point always adds its effect now (1,5 = rerolagem + ½ prof.), not only when it's alone
  return { amp, red, ampGroups: Math.floor(a / 2), ampReroll: a % 2 === 1, ampFlat: amp - a === 0.5, redHalvings: Math.floor(r / 2), redReroll: r % 2 === 1, redFlat: red - r === 0.5 };
}
// each group of 2 points: +1 die per 2; an odd die left over: +1/4 of its max (rounded up)
export function amplifyDice(amount, sides, groups) {
  let bonus = 0;
  for (let i = 0; i < groups; i++) {
    if (amount % 2 === 1) bonus += Math.ceil(sides / 4);
    amount += Math.floor(amount / 2);
  }
  return { amount, bonus };
}
// Life Orb: +1 die per 3; dice left over -> reroll keeping the higher
export function perThreeDice(amount, times) {
  let reroll = false;
  for (let i = 0; i < times; i++) { if (amount % 3 !== 0) reroll = true; amount += Math.floor(amount / 3); }
  return { amount, reroll };
}

// the whole damage-dice recipe (pokemon.lua get_damage_mod_stab), from the move's own dice:
// { amount, flat, reroll (1 maior / -1 menor / 0), halvings, restAmount, restReroll, amp, red, diceMult }
// restAmount/restReroll: the other "times" of a move like 2x1d8 (Amplificação só no primeiro golpe)
export function damageDice({ amount, sides, amp, red, diceMult = 1, perThree = 0, halfProf = 1 }) {
  if (!amount || !sides) {
    const s = summary(amp, red);
    return { amount: 0, flat: (s.ampFlat ? halfProf : 0) - (s.redFlat ? halfProf : 0), reroll: 0, halvings: s.redHalvings, restAmount: 0, restReroll: 0, amp: s.amp, red: s.red, diceMult };
  }
  // "corta os dados pela metade" com 1 dado só: vira 1 ponto de Redução
  if (diceMult < 1 && amount === 1) { diceMult = 1; red += 1; }
  const pt = Math.max(0, Math.min(perThree, Math.floor(amp)));
  const s = summary(Math.max(0, amp - pt), red);
  let first = amount, reroll3 = false;
  if (pt) ({ amount: first, reroll: reroll3 } = perThreeDice(first, pt));
  const g = amplifyDice(first, sides, s.ampGroups);
  first = g.amount;
  let rest = amount;
  if (diceMult !== 1) { first = Math.max(1, Math.floor(first * diceMult)); rest = Math.max(1, Math.floor(rest * diceMult)); }
  const keepHigh = s.ampReroll || reroll3, keepLow = s.redReroll;
  return {
    amount: first,
    flat: g.bonus + (s.ampFlat ? halfProf : 0) - (s.redFlat ? halfProf : 0),
    reroll: keepHigh && !keepLow ? 1 : keepLow && !keepHigh ? -1 : 0,
    halvings: s.redHalvings,
    restAmount: rest, restReroll: keepLow ? -1 : 0,
    amp: summary(amp, 0).amp, red: s.red, diceMult,
  };
}

// short text for the notes: "3 pts: +1 dado a cada 2 e rola 2x (maior)"
export function pointsText(amp, red) {
  const s = summary(amp, red);
  const out = [];
  if (s.ampFlat) out.push("+½ prof. de dano");
  if (s.ampGroups) out.push(`+1 dado a cada 2${s.ampGroups > 1 ? ` (${s.ampGroups}x)` : ""}`);
  if (s.ampReroll) out.push("rola o dano 2x e fica com o maior");
  if (s.redFlat) out.push("−½ prof. de dano");
  if (s.redReroll) out.push("rola o dano 2x e fica com o menor");
  if (s.redHalvings) out.push(`dano final ÷${2 ** s.redHalvings}`);
  return out.join(" · ");
}
