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
    // a few app moves describe a save ("teste de CON contra sua CD de Move") without the "Save" field
    const SAVE_RX = /teste (?:de resist[eê]ncia )?de (FOR|DES|CON|INT|SAB|CAR)\b[^.]{0,40}?contra (?:a )?sua CD/i;
    const PT_ATTR = { FOR: "STR", DES: "DEX", CON: "CON", INT: "INT", SAB: "WIS", CAR: "CHA" };
    for (const m of Object.values(moves)) {
      const s = !m.Save && SAVE_RX.exec(m.Description ?? "");
      if (s) m.Save = PT_ATTR[s[1].toUpperCase()];
    }
    this.species = pokemon;
    this.leveling = rules.leveling;
    this.natures = rules.natures;
    this.featText = rules.feats ?? {};
    this.abilityText = rules.abilities ?? {};
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

  // M.get_all_speed in meters (the data is in feet: 5 ft = 1,5 m). Velocidade stage: +1,5 m each;
  // "Mobilidade" feat: +3 m. Items/abilities not included.
  speeds(pkmn) {
    const sp = this.speciesData(pkmn) ?? {};
    const extra = (pkmn.stages?.Speed ?? 0) * 5 + (this.featCount(pkmn, "Mobilidade") ? 10 : 0);
    const m = (ft) => (ft ? Math.max(0, ((ft + extra) / 5) * 1.5) : 0);
    return { walk: m(sp.WSp), fly: m(sp.Fsp), swim: m(sp.Ssp), climb: m(sp["Climbing Speed"]), burrow: m(sp["Burrowing Speed"]) };
  }

  // size category: 0 Miúdo, 1 Pequeno, 2 Médio, 3 Grande, 4 Enorme, 5 Imenso
  sizeRank(pkmn) {
    const s = (this.speciesData(pkmn)?.size ?? "Médio").toLowerCase();
    if (/mi[uú]do|tiny/.test(s)) return 0;
    if (/pequeno|small/.test(s)) return 1;
    if (/grande|large/.test(s)) return 3;
    if (/enorme|huge/.test(s)) return 4;
    if (/imenso|gargantuan/.test(s)) return 5;
    return 2;
  }
  // melee reach (pág. 54): 1,5 m up to Grande, 3 m above that
  reach(pkmn) { return this.sizeRank(pkmn) >= 4 ? 3 : 1.5; }
  hasFeat(pkmn, feat) { return this.featCount(pkmn, feat) > 0; }
  // skill check bonus: attribute mod + proficiency when the species has the skill
  skillMod(pkmn, skill, attr) {
    const skills = this.speciesData(pkmn)?.Skill ?? [];
    return mod(this.attributes(pkmn)[attr]) + (skills.includes(skill) ? this.proficiency(pkmn) : 0);
  }

  // M.get_initiative_modifier (without speed stage, item and ability bonuses)
  initiative(pkmn) {
    return mod(this.attributes(pkmn).DEX) + (this.featCount(pkmn, "Alerta") ? 5 : 0);
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
    return pp + this.featCount(pkmn, "Incansável") + (pkmn.moves?.[name]?.pp_up ?? 0) * 2;
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
      rangeInfo: this.rangeFor(pkmn, parseRange(move.Range)),
      ppMax: this.moveMaxPP(pkmn, name),
      pp: this.movePP(pkmn, name),
      stab,
      attackBonus: null,
      saveDC: null,
      save: move.Save ?? null,
      damage: null,
    };
    const desc = move.Description ?? "";
    // "Faça dois/três ataques": one attack roll per strike (Double Kick, Dual Wingbeat, Triple Axel...);
    // the app's Move Power already carries the "com -1" of the text
    const many = /fa[çc]a\s+(dois|duas|tr[êe]s|2|3)\s+ataques/i.exec(desc);
    if (many) {
      out.hits = { dois: 2, duas: 2, "2": 2 }[many[1].toLowerCase()] ?? 3;
      out.firstOnlyBonus = /apenas ao dano do primeiro golpe/i.test(desc);
      out.scaleDice = /triplo da quantidade de dados/i.test(desc); // Triple Axel: 1x, 2x, 3x the dice
    }
    // "acerto garantido" (Swift, Aerial Ace...): no attack against the AC, the d20 only says if it's a crit
    if (move.atk !== true && !many && move.Damage && !move.Save
      && /acerto garantido|garantid[oa] de acertar|imposs[íi]vel (para ela |de )?desviar|n[ãa]o (pode|consegue) errar|sempre acerta/i.test(desc)) out.sureHit = true;
    if ((move.atk === true || many) && !move.autohit) out.attackBonus = (powerMod ?? 0) + this.proficiency(pkmn);
    if (move.Save) out.saveDC = 8 + (powerMod ?? 0) + this.proficiency(pkmn);
    const dmg = move.Damage?.[this.levelIndex(pkmn)];
    if (dmg) {
      let bonus = stab + (dmg.level ? this.level(pkmn) : 0);
      const moveMod = dmg.move ? this.movePower(pkmn, move, false) ?? 0 : 0;
      bonus += moveMod;
      out.damage = { amount: dmg.amount, dice: dmg.dice_max, bonus, times: Number(dmg.times) || 1, moveMod };
      out.damageText = formatDamage(out.damage) + (out.hits ? ` por golpe (${out.hits} ataques)` : "");
    }
    return out;
  }

  // the Pokémon's own reach for plain melee; "Controlador de Área" doubles areas
  rangeFor(pkmn, r) {
    if (r.kind === "melee" && r.label === "corpo a corpo" && this.reach(pkmn) > r.meters) return { ...r, meters: this.reach(pkmn), label: `corpo a corpo (${fmtM(this.reach(pkmn))})` };
    if (r.kind === "area" && this.hasFeat(pkmn, "Controlador de Área")) {
      const meters = r.meters * 2;
      return { ...r, meters, label: r.label.replace(/[\d,]+ m$/, fmtM(meters)) + " (Controlador de Área)" };
    }
    return r;
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

// Reads the PMP "Range" text. kind:
//   melee  "Corpo a corpo" (1,5 m) or "Corpo a corpo (12 metros)"
//   ranged "(9 metros)", "6 m"
//   area   "Pessoal (cone/raio/linha de 12 metros)": targets within that distance of the user
//   self   "Pessoal": only the user
//   any    "Variável", empty or anything not understood: not checked
export function parseRange(text) {
  const t = (text ?? "").trim();
  const low = t.toLowerCase();
  const num = low.match(/(\d+(?:,\d+)?)\s*(?:metros|m\b)/);
  const meters = num ? parseFloat(num[1].replace(",", ".")) : null;
  const melee = low.startsWith("corpo a corpo") || low === "melee" || low.startsWith("toque");
  if (melee && !meters) return { kind: "melee", meters: 1.5, label: "corpo a corpo" };
  if (melee) return { kind: "melee", meters, label: `corpo a corpo, ${fmtM(meters)}` };
  if (low.startsWith("pessoal") && meters) {
    const shape = low.includes("cone") ? "cone" : low.includes("linha") ? "line" : low.includes("semic") ? "semicircle" : "radius";
    const name = { cone: "cone", line: "linha", semicircle: "semicírculo", radius: "raio" }[shape];
    return { kind: "area", shape, meters, label: `${name} de ${fmtM(meters)}` };
  }
  if (low.startsWith("pessoal")) return { kind: "self", meters: 0, label: "pessoal" };
  if (meters) return { kind: "ranged", meters, label: fmtM(meters) };
  return { kind: "any", meters: null, label: t || "—" };
}
const fmtM = (m) => `${String(m).replace(".", ",")} m`;
export { fmtM };

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
