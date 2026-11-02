// PMP rules, ported from the app (pokedex/pokemon.lua). Function names follow the Lua ones.
// Not ported yet: trainer bonuses, held items, ability effects, amplification points, stages, mega.

export const ATTRS = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
export const ATTR_PT = { STR: "FOR", DEX: "DES", CON: "CON", INT: "INT", WIS: "SAB", CHA: "CAR" };

export const TYPE_PT = {
  Normal: "Normal", Fire: "Fogo", Water: "Água", Grass: "Grama", Electric: "Elétrico", Ice: "Gelo",
  Fighting: "Lutador", Poison: "Venenoso", Ground: "Terrestre", Flying: "Voador", Psychic: "Psíquico",
  Bug: "Inseto", Rock: "Pedra", Ghost: "Fantasma", Dragon: "Dragão", Dark: "Sombrio", Steel: "Aço",
  Fairy: "Fada", Typeless: "Sem tipo",
};

const FEAT_TO_ATTRIBUTE = {
  "Resiliente (FOR)": "STR", "Resiliente (CON)": "CON", "Resiliente (DES)": "DEX",
  "Resiliente (INT)": "INT", "Resiliente (SAB)": "WIS", "Resiliente (CAR)": "CHA",
  "Atleta (FOR)": "STR", "Atleta (DES)": "DEX", "Dedos RÁpidos": "DEX", Sorrateiro: "DEX",
  Musculoso: "STR", Perceptivo: "WIS", Acrobata: "DEX", Ator: "CHA",
};
const RESILIENT = {
  "Resiliente (FOR)": "STR", "Resiliente (CON)": "CON", "Resiliente (DES)": "DEX",
  "Resiliente (INT)": "INT", "Resiliente (SAB)": "WIS", "Resiliente (CAR)": "CHA",
};
const FULL_TO_ABBR = { Strength: "STR", Dexterity: "DEX", Constitution: "CON", Intelligence: "INT", Wisdom: "WIS", Charisma: "CHA" };

// attacker type -> defender type -> multiplier (only the non-1 entries)
const CHART = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};

const mod = (score) => Math.floor((score - 10) / 2);

export class Rules {
  constructor({ moves, pokemon, rules }) {
    this.moves = moves;
    this.species = pokemon;
    this.leveling = rules.leveling;
    this.natures = rules.natures;
  }

  // pokedex.get_pokemon: species data with the variant's overrides applied
  speciesData(pkmn) {
    const raw = this.species[pkmn.species?.current];
    if (!raw) return null;
    const v = pkmn.variant && raw.variant_data?.variants?.[pkmn.variant];
    return v?.diff ? { ...raw, ...v.diff } : raw;
  }

  level(pkmn) { return pkmn.level?.current ?? 1; }
  levelData(pkmn) { return this.leveling[String(this.level(pkmn))] ?? { prof: 2, STAB: 0 }; }
  proficiency(pkmn) { return this.levelData(pkmn).prof; }
  stabBonus(pkmn) { return this.levelData(pkmn).STAB; }
  feats(pkmn) { return pkmn.feats ?? []; }
  featCount(pkmn, feat) { return this.feats(pkmn).filter((f) => f === feat).length; }
  nature(pkmn) { return this.natures[pkmn.nature] ?? this.natures["No Nature"] ?? {}; }
  types(pkmn) { return pkmn.ability_active_type ? [pkmn.ability_active_type] : this.speciesData(pkmn)?.Type ?? ["Typeless"]; }
  abilities(pkmn) { return pkmn.abilities?.length ? pkmn.abilities : this.speciesData(pkmn)?.Abilities ?? []; }
  name(pkmn) { return pkmn.nickname || pkmn.species?.current || "?"; }

  // M.get_attributes (without trainer, mega and active-ability effects)
  attributes(pkmn) {
    const base = this.speciesData(pkmn)?.attributes ?? {};
    const a = pkmn.attributes ?? {};
    const nat = this.nature(pkmn);
    const pre = {};
    for (const k of ATTRS) {
      pre[k] = (base[k] ?? 10) + (a[k] ?? 0) + (nat[k] ?? 0) + (a.increased?.[k] ?? 0) + (a.custom?.[k] ?? 0);
    }
    for (const f of this.feats(pkmn)) if (FEAT_TO_ATTRIBUTE[f]) pre[FEAT_TO_ATTRIBUTE[f]] += 1;
    const vit = pkmn.vitamins?.attributes ?? {};
    const out = {};
    for (const k of ATTRS) {
      const amount = vit[k] ?? 0;
      const phantom = pre[k] % 2 !== 0 && amount > 0 ? 1 : 0;
      out[k] = pre[k] + amount * 2 + phantom;
    }
    return out;
  }

  // M.get_total_max_hp
  maxHP(pkmn) {
    if (this.abilities(pkmn).includes("Paper Thin")) return 1;
    const lvl = this.level(pkmn);
    const tough = this.featCount(pkmn, "Robusto") ? lvl * 2 : 0;
    const loyalty = pkmn.loyalty ?? 0;
    const loyaltyHP = loyalty === 2 ? Math.ceil(lvl / 2) : loyalty === 3 ? lvl : 0;
    const hpUp = (pkmn.vitamins?.hp_up ?? 0) * (this.speciesData(pkmn)?.["Hit Dice"] ?? 0);
    return (pkmn.hp?.max ?? 0) + tough + loyaltyHP + lvl * mod(this.attributes(pkmn).CON) + hpUp;
  }

  // M.get_AC (without items, stages, mega and abilities)
  ac(pkmn) {
    return (this.speciesData(pkmn)?.AC ?? 10) + (this.nature(pkmn).AC ?? 0) + this.featCount(pkmn, "Aumento de CA");
  }

  // M.get_saving_throw_modifier
  saves(pkmn) {
    const attrs = this.attributes(pkmn);
    const loyalty = Math.max(-1, Math.min(1, pkmn.loyalty ?? 0));
    const profs = new Set((this.speciesData(pkmn)?.saving_throws ?? []).map((s) => FULL_TO_ABBR[s] ?? s));
    for (const f of this.feats(pkmn)) if (RESILIENT[f]) profs.add(RESILIENT[f]);
    const out = {};
    for (const k of ATTRS) out[k] = mod(attrs[k]) + loyalty + (profs.has(k) ? this.proficiency(pkmn) : 0);
    return out;
  }

  levelIndex(pkmn) {
    const l = this.level(pkmn);
    return l >= 17 ? "17" : l >= 10 ? "10" : l >= 5 ? "5" : "1";
  }

  // get_attack_roll_mod (withModifier) / get_unmodified_attribute_bonus (without)
  movePower(pkmn, move, withModifier) {
    const power = move["Move Power"];
    if (!power || !Object.keys(power).length) return 0;
    const attrs = this.attributes(pkmn);
    let best = -9999;
    for (const [attr, m] of Object.entries(power)) {
      if (attrs[attr] != null) best = Math.max(best, mod(attrs[attr]) + (withModifier ? m : 0));
      else if (attr === "Any") best = mod(Math.max(...Object.values(attrs))) + (withModifier ? m : 0);
    }
    return best === -9999 ? null : best; // "None": move has no attribute
  }

  moveMaxPP(pkmn, name) {
    const pp = this.moves[name]?.PP ?? 0;
    if (typeof pp === "string") return pp;
    return pp + this.featCount(pkmn, "IncansÁvel") + (pkmn.moves?.[name]?.pp_up ?? 0) * 2;
  }

  movePP(pkmn, name) {
    const pp = pkmn.moves?.[name]?.pp;
    return pp ?? this.moveMaxPP(pkmn, name);
  }

  // M.get_move_data + get_damage_mod_stab
  moveData(pkmn, name) {
    const move = this.moves[name] ?? this.moves.Error;
    if (!move) return { name, missing: true };
    const isAttack = move.atk === true || move.auto_hit === true || move.Damage != null || move.Save != null;
    const types = this.types(pkmn);
    const stab = isAttack && types.includes(move.Type) ? this.stabBonus(pkmn) : 0;
    const powerMod = this.movePower(pkmn, move, true);
    const out = {
      name,
      label: move.Name ?? name,
      type: move.Type ?? "Typeless",
      time: move["Move Time"],
      range: move.Range,
      duration: move.Duration,
      description: move.Description,
      scaling: move.Scaling,
      table: move.Table,
      ppMax: this.moveMaxPP(pkmn, name),
      pp: this.movePP(pkmn, name),
      stab,
      attackBonus: null,
      saveDC: null,
      save: move.Save ?? null,
      damage: null,
    };
    if (move.atk === true && !move.autohit) out.attackBonus = (powerMod ?? 0) + this.proficiency(pkmn);
    if (move.Save) out.saveDC = 8 + (powerMod ?? 0) + this.proficiency(pkmn);
    const dmg = move.Damage?.[this.levelIndex(pkmn)];
    if (dmg) {
      let bonus = stab + (dmg.level ? this.level(pkmn) : 0);
      if (dmg.move) bonus += this.movePower(pkmn, move, false) ?? 0;
      out.damage = { amount: dmg.amount, dice: dmg.dice_max, bonus, times: Number(dmg.times) || 1 };
      out.damageText = formatDamage(out.damage);
    }
    return out;
  }

  moveList(pkmn) {
    const entries = Object.entries(pkmn.moves ?? {}).sort((a, b) => (a[1].index ?? 99) - (b[1].index ?? 99));
    return entries.map(([name]) => this.moveData(pkmn, name));
  }

  // damage multiplier of a move type against a defender
  effectiveness(moveType, defender) {
    if (!moveType || moveType === "Typeless") return 1;
    let m = 1;
    for (const t of this.types(defender)) m *= CHART[moveType]?.[t] ?? 1;
    return m;
  }
}

export function formatDamage({ amount, dice, bonus, times }) {
  let text = amount && dice ? `${amount}d${dice}` : "";
  if (bonus) text += (bonus > 0 ? "+" : "") + bonus;
  return (times > 1 ? `${times}x` : "") + (text || "0");
}

// ------------------------------------------------------------------ dice

export function d(sides) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % sides) + 1;
}

export function rollDice(amount, sides) {
  return Array.from({ length: amount }, () => d(sides));
}

export const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
