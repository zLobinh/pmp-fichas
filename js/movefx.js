// Moves whose effect is more than "hit, damage, stage, condition": healing, draining, recoil, fixed
// damage, dice that double on a condition, variable number of hits, weather/terrain moves, Leech Seed,
// Taunt & co., Substitute, Stockpile... The texts are the PMP ones (moves.json).
import { d } from "./rules.js?v=0.9.18";

const MULTI_TABLE = (n) => (n >= 8 ? 4 : n >= 7 ? 3 : n >= 4 ? 2 : 1); // "D8: 1-3 mais 1 ... 8 mais 4"
const MINIMIZE_HIT = ["Stomp", "Body Slam", "Dragon Rush", "Flying Press", "Steamroller", "Heavy Slam", "Heat Crash", "Supercell Slam"];
const FLY_HIT = ["Gust", "Twister"];
const SOLAR = ["Solar Beam", "Solar Blade"];
const LOCK = ["Outrage", "Thrash", "Petal Dance", "Raging Fury"];
const RESTRICT = { Taunt: "taunt", Encore: "encore", Disable: "disable", Torment: "torment", "Heal Block": "healBlock", "Psychic Noise": "healBlock" };
const SCREEN_BREAK = ["Brick Break", "Psychic Fangs", "Raging Bull"];
const HP_TYPES = [null, "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"];
const WEATHER_BALL = { sun: "Fire", rain: "Water", sand: "Rock", hail: "Ice", snow: "Ice" };
const TERRAIN_TYPE = { electric: "Electric", grassy: "Grass", misty: "Fairy", psychic: "Psychic" };
const NONVOL = ["Burning", "Frozen", "Paralyzed", "Poisoned", "BadlyPoisoned", "Drowsy", "Asleep"];

const descOf = (raw) => (raw?.Description ?? "").replace(/\s+/g, " ");
const lvlHalf = (lvl) => Math.max(2, Math.ceil(lvl / 2));
const frac = (s) => (/1\/3|um ter[çc]o/i.test(s) ? 1 / 3 : /1\/4|um quarto/i.test(s) ? 1 / 4 : /metade/i.test(s) ? 1 / 2 : null);

// static facts about a move, from its name and text
export function special(name, raw) {
  const t = descOf(raw);
  const s = { name };
  // healing: "recupera 2d6 + MOVE pontos de vida", "cure a si mesmo em 2d6 + MOVE"
  const heal = /(?:recupera\w*|cur[ae]\w*(?: a si mesmo)?(?: em)?)\s+(\d+)d(\d+)\s*\+\s*MOVE/i.exec(t);
  // (the app keeps some healing dice in "Damage": a move with no attack and no save is a heal)
  if (heal && !raw?.atk && !raw?.Save) {
    s.heal = { amount: Number(heal[1]), sides: Number(heal[2]) };
    s.heal.self = /^pessoal/i.test((raw?.Range ?? "").trim()) || /a si mesmo|apenas para si|para si\b/i.test(t);
    if (name === "Wish") s.heal.delayed = true;
    if (name === "Heal Pulse" || name === "Floral Healing" || name === "Life Dew") s.heal.self = name === "Life Dew";
  }
  if (["Moonlight", "Morning Sun", "Synthesis"].includes(name)) s.heal = { table: true, self: true };
  if (name === "Rest") s.heal = { amount: 4, sides: 6, self: true, rest: true };
  if (name === "Swallow") s.heal = { amount: 1, sides: 6, self: true, stockpile: true };
  if (name === "Shore Up") s.heal.sandBonus = true;
  if (name === "Roost") s.roost = true;
  // drain / recoil
  if (raw?.Damage && /metade do dano (causado|infligido)|ganhando metade do dano/i.test(t) && !/recuo/i.test(t)) s.drain = { frac: 0.5, up: name === "Absorb" };
  const rc = /(sofr\w+|receb\w+)\s+([^.]{0,40}?)\s*(?:do (?:dano|total)[^.]{0,30}?)?(?:como |em )?(?:dano )?(?:de )?recuo|recuo[^.]{0,20}/i.exec(t);
  if (raw?.Damage && /recuo/i.test(t) && name !== "Substitute" && name !== "Shed Tail") {
    const f = frac(/(1\/3|1\/4|um ter[çc]o|um quarto|metade)[^.]{0,60}recuo|recuo[^.]{0,60}(1\/3|1\/4|um ter[çc]o|um quarto|metade)/i.exec(t)?.[0] ?? (rc?.[0] ?? ""));
    if (f) s.recoil = f;
  }
  const miss = /(?:caso|se)\s+(?:falhe|errar|erre|falhar)[^.]*sofre\s+dano[^.]*?(dobro do seu n[ií]vel|metade d[eo]s? (?:seus )?(?:PV|pontos de vida) m[aá]ximos)/i.exec(t);
  if (miss) s.missRecoil = /dobro/i.test(miss[1]) ? "2lvl" : "halfmax";
  // variable number of strikes: "role um d8 e compare ... quantidade de golpes"
  if (/quantidade de golpes/i.test(t)) s.multiTable = true;
  if (/se um deles errar, o move termina/i.test(t)) s.stopOnMiss = true;
  // fixed damage
  if (["Seismic Toss", "Night Shade"].includes(name)) s.fixed = "lvlProf";
  if (name === "Dragon Rage") s.fixed = 8;
  if (name === "Sonic Boom") s.fixed = 4;
  if (["Super Fang", "Ruination", "Nature's Madness"].includes(name)) s.fixed = "halfHp";
  if (["Counter", "Mirror Coat", "Metal Burst", "Comeuppance"].includes(name)) s.fixed = "counter";
  if (name === "Endeavor") s.endeavor = true;
  if (name === "Final Gambit") s.gamble = true;
  if (name === "Pain Split") s.painSplit = true;
  if (/(?:o usu[aá]rio|voc[eê]) desmaia ao utilizar|desmaiando imediatamente antes do dano/i.test(t)) s.selfKO = true;
  if (name === "Memento") s.selfKOOnSuccess = true;
  if (["Healing Wish", "Lunar Dance"].includes(name)) s.healingWish = true;
  if (["False Swipe", "Hold Back"].includes(name)) s.leaveOne = true;
  if (name === "Body Press") s.atkFrom = "Defense";
  if (name === "Foul Play") s.foul = true;
  if (["Psyshock", "Psystrike", "Secret Sword"].includes(name)) s.defAs = "Defense";
  if (name === "Hidden Power") s.hiddenPower = true;
  if (name === "Present") s.present = true;
  if (name === "Weather Ball") s.weatherBall = true;
  if (name === "Terrain Pulse") s.terrainPulse = true;
  if (name === "Fury Cutter") s.furyCutter = true;
  if (name === "Stockpile") s.stockpile = true;
  if (name === "Spit Up") s.spitUp = true;
  if (["Eruption", "Water Spout", "Dragon Energy"].includes(name)) s.hpDice = "spout";
  if (["Reversal", "Flail"].includes(name)) s.hpDice = "reversal";
  if (["Gyro Ball"].includes(name)) s.initDice = -1;
  if (["Electro Ball"].includes(name)) s.initDice = 1;
  if (["Heavy Slam", "Heat Crash"].includes(name)) s.sizeDice = "heavier";
  if (["Low Kick", "Grass Knot"].includes(name)) s.sizeDice = "target";
  if (["Return"].includes(name)) s.loyalty = 1;
  if (["Frustration"].includes(name)) s.loyalty = -1;
  if (name === "Fickle Beam") s.fickle = true;
  if (name === "Knock Off") s.knockOff = true;
  if (name === "Leech Seed") s.seed = true;
  if (name === "Curse") s.curse = true;
  if (name === "Perish Song") s.perish = true;
  if (name === "Yawn") s.yawn = true;
  if (RESTRICT[name]) s.restrict = RESTRICT[name];
  if (LOCK.includes(name)) s.lock = true;
  if (name === "Substitute") s.sub = true;
  if (name === "Charge") s.charge = true;
  if (name === "Defense Curl") s.defenseCurl = true;
  if (name === "Minimize") s.minimize = true;
  if (["Aromatherapy", "Heal Bell"].includes(name)) s.cureTeam = name === "Heal Bell" ? 18 : 6;
  if (name === "Haze") s.haze = 12;
  if (name === "Clear Smog") s.clearTarget = true;
  if (name === "Magnet Rise") s.magnetRise = true;
  if (SCREEN_BREAK.includes(name)) s.breakScreens = true;
  if (["Steel Roller", "Ice Spinner"].includes(name)) s.clearTerrain = name === "Steel Roller" ? "before" : "hit";
  if (SOLAR.includes(name)) s.solar = true;
  if (["Thunder", "Hurricane"].includes(name)) s.rainSure = true;
  if (name === "Blizzard") s.hailSure = true;
  if (MINIMIZE_HIT.includes(name)) s.minimizeHit = true;
  if (FLY_HIT.includes(name)) s.flyHit = true;
  if (["Fusion Bolt", "Fusion Flare"].includes(name)) s.fusion = name === "Fusion Bolt" ? "Fusion Flare" : "Fusion Bolt";
  const VORTEX = { Whirlpool: "Water", "Fire Spin": "Fire", "Sand Tomb": "Ground", Infestation: "Bug", "Magma Storm": "Fire", "G-Max Sandblast": "Ground" };
  if (VORTEX[name]) s.vortex = VORTEX[name];
  if (["Wrap", "Bind", "Clamp", "Snap Trap", "Thunder Cage", "Octolock"].includes(name)) s.bind = true;
  return s;
}

// before anything is rolled: restrictions on the user (Taunt, Encore, Disable, Torment, Heal Block,
// Outrage lock, Truant, Damp). Returns an error message or null.
export function restricted(rules, aSheet, name, raw, ctx = {}) {
  const b = aSheet.battle ?? {};
  const damaging = !!raw?.Damage;
  if (b.locked && b.locked.move !== name) return `${b.locked.move}: está em frenesi e só pode usar esse Move (mais ${b.locked.left} turno(s)).`;
  if (b.truantLazy && (aSheet.battle?.ability ?? null) !== "x" && rules.abilities(aSheet.pkmn).includes("Truant")) return "Truant: neste turno ele está com preguiça e não usa Moves.";
  const r = b.restrict ?? {};
  if (r.taunt && !damaging) return "Provocado (Taunt): só pode usar Moves de dano.";
  if (r.encore && r.encore.move && r.encore.move !== name) return `Encore: só pode usar ${r.encore.move}.`;
  if (r.disable?.move === name || b.disabled?.move === name) return `${name} está bloqueado (Disable/Cursed Body).`;
  if (r.torment && b.lastMove === name) return "Torment: não pode usar o mesmo Move duas vezes seguidas.";
  if (r.healBlock && special(name, raw).heal) return "Heal Block: não pode usar Moves de cura.";
  if (ctx.damp && ["Self-Destruct", "Explosion", "Mind Blown", "Misty Explosion"].includes(name)) return `${ctx.damp} (Damp) impede explosões.`;
  return null;
}

// the move's type for this use (Hidden Power, Weather Ball, Terrain Pulse)
export function typeFor(sp, move, ctx) {
  if (sp.weatherBall && ctx.field.weather) return WEATHER_BALL[ctx.field.weather];
  if (sp.terrainPulse && ctx.field.terrain && ctx.grounded) return TERRAIN_TYPE[ctx.field.terrain];
  if (sp.hiddenPower) {
    let n;
    do n = d(20); while (n >= 19);
    return HP_TYPES[n];
  }
  return null;
}

// dice changes that don't depend on the target: weather/terrain on the move's type, Stockpile...
// returns { double, halfMore, halve, keepHigh, mult (dice count ×), add (dice), sure, accDelta, notes }
export function userDice(rules, aSheet, move, sp, ctx) {
  const o = { double: false, halfMore: false, halve: false, keepHigh: false, mult: 1, add: 0, sure: false, accDelta: 0, finalMult: 1, notes: [] };
  // (weather and terrain on the move's type are damage points now: amp.js FIELD_AMP)
  const w = ctx.field.weather, tr = ctx.field.terrain;
  const t = ctx.type ?? move.type;
  if (sp.rainSure && w === "rain") { o.sure = true; o.notes.push("chuva: acerto garantido"); }
  if (sp.rainSure && w === "sun") { o.accDelta -= 2; o.notes.push("sol: −5 no acerto"); }
  if (ctx.grounded) {
    if (tr === "electric" && move.name === "Rising Voltage") { o.double = true; o.notes.push("Rising Voltage no Electric Terrain"); }
    if (tr && sp.terrainPulse) { o.double = true; o.notes.push("Terrain Pulse no terreno"); }
    if (tr === "misty" && move.name === "Misty Explosion") { o.groups = 1; o.notes.push("Misty Terrain"); }
  }
  if (tr === "electric" && move.name === "Psyblade") { o.halfMore = true; o.notes.push("Psyblade no Electric Terrain"); }
  if (sp.weatherBall && w) { o.double = true; o.notes.push("Weather Ball no clima"); }
  if (move.name === "Expanding Force" && tr === "psychic") { o.add += 2; o.notes.push("Psychic Terrain: +2 dados"); }
  const b = aSheet.battle ?? {};
  if (sp.spitUp && b.stockpile) { o.mult *= b.stockpile; o.notes.push(`Stockpile ×${b.stockpile}`); }
  if (sp.furyCutter && b.furyCutter) { o.mult *= Math.min(4, 2 ** b.furyCutter); o.notes.push(`Fury Cutter ×${Math.min(4, 2 ** b.furyCutter)}`); }
  if (["Rollout", "Ice Ball"].includes(move.name) && b.defenseCurl) { o.double = true; o.notes.push("Defense Curl: dados dobrados"); }
  if (sp.loyalty) { const l = Math.max(-3, Math.min(3, aSheet.pkmn.loyalty ?? 0)) * sp.loyalty; o.add += l; if (l) o.notes.push(`lealdade ${l > 0 ? "+" : ""}${l} dado(s)`); }
  const max = Math.max(1, rules.maxHP(aSheet.pkmn)), hp = aSheet.pkmn.hp.current;
  if (sp.hpDice === "spout" && hp < max) { const lost = 1 + Math.floor(((max - hp) / max) * 4); o.add -= lost; o.notes.push(`−${lost} dado(s) pela vida perdida`); }
  if (sp.hpDice === "reversal" && hp < max) {
    const p = (hp / max) * 100;
    const k = p < 5 ? 10 : p < 10 ? 7 : p < 20 ? 5 : p < 35 ? 3 : p < 70 ? 2 : 1;
    if (k > 1) { o.mult *= k; o.notes.push(`vida baixa: dados ×${k}`); }
  }
  if (["Facade"].includes(move.name) && ["Poisoned", "BadlyPoisoned", "Paralyzed", "Burning"].some((k) => b.cond?.[k])) { o.double = true; o.notes.push("Facade: dados dobrados"); }
  if (move.name === "Acrobatics" && (!aSheet.pkmn.item || b.itemLost)) { o.double = true; o.notes.push("Acrobatics sem item: dados dobrados"); }
  if (move.name === "Lash Out" && Object.values(aSheet.pkmn.stages ?? {}).some((v) => v < 0)) { o.double = true; o.notes.push("Lash Out: dados dobrados"); }
  if (["Temper Flare", "Stomping Tantrum"].includes(move.name) && b.lastMissed) { o.double = true; o.notes.push("errou o último: dados dobrados"); }
  if (sp.fusion && ctx.field.raw?.fusion?.move === sp.fusion && ctx.field.raw.fusion.round >= ctx.field.round - 1) { o.double = true; o.notes.push(`${sp.fusion} antes: dados dobrados`); }
  return o;
}

// per target: { double, add, sure, notes }
export function targetDice(rules, aSheet, tSheet, aItem, tItem, move, sp, ctx) {
  const o = { double: false, add: 0, sure: false, notes: [] };
  if (!tSheet?.pkmn) return o;
  const tb = tSheet.battle ?? {}, ab = aSheet.battle ?? {};
  const tc = tb.cond ?? {};
  const pct = tSheet.pkmn.hp.current / Math.max(1, rules.maxHP(tSheet.pkmn));
  const dbl = (cond, why) => { if (cond) { o.double = true; o.notes.push(why); } };
  dbl(["Hex", "Infernal Parade"].includes(move.name) && Object.keys(tc).some((k) => NONVOL.includes(k) || k === "Confused" || k === "Stunned"), "alvo com condição: dados dobrados");
  dbl(["Venoshock", "Barb Barrage"].includes(move.name) && (tc.Poisoned || tc.BadlyPoisoned), "alvo envenenado: dados dobrados");
  dbl(move.name === "Brine" && pct < 0.5, "alvo abaixo de 50%: dados dobrados");
  dbl(move.name === "Smelling Salts" && tc.Paralyzed, "alvo paralisado: dados dobrados");
  dbl(move.name === "Wake-Up Slap" && tc.Asleep, "alvo dormindo: dados dobrados");
  const hitMe = ab.lastHit && ab.lastHit.by === tItem.id && ab.lastHit.round >= ctx.field.round - 1;
  dbl(["Payback", "Revenge", "Avalanche"].includes(move.name) && hitMe, "o alvo te atingiu: dados dobrados");
  dbl(move.name === "Assurance" && tb.lastHit && tb.lastHit.by !== aItem.id && tb.lastHit.round === ctx.field.round, "o alvo já levou dano nesta rodada: dados dobrados");
  dbl(move.name === "Retaliate" && (ctx.others ?? []).some((o2) => o2.ally && o2.sheet.battle?.koBy === tItem.id && o2.sheet.battle.koRound >= ctx.field.round - 1), "vingança: dados dobrados");
  const ia = Number(aItem.metadata?.["com.pretty-initiative/metadata"]?.count), it = Number(tItem.metadata?.["com.pretty-initiative/metadata"]?.count);
  dbl(["Bolt Beak", "Fishious Rend"].includes(move.name) && Number.isFinite(ia) && Number.isFinite(it) && ia > it, "iniciativa maior: dados dobrados");
  if (sp.minimizeHit && tb.minimized) { o.double = true; o.sure = true; o.notes.push("Minimize: acerto garantido e dados dobrados"); }
  dbl(sp.flyHit && tb.charging?.invuln && ["Fly", "Bounce", "Sky Drop"].includes(tb.charging.move), "alvo no ar: dados dobrados");
  if (sp.initDice && Number.isFinite(ia) && Number.isFinite(it)) {
    const n = Math.max(0, Math.min(5, Math.floor(((ia - it) * sp.initDice) / 5)));
    if (n) { o.add += n; o.notes.push(`+${n} dado(s) pela iniciativa`); }
  }
  if (sp.sizeDice === "heavier") { const n = rules.sizeRank(aSheet.pkmn) - rules.sizeRank(tSheet.pkmn); if (n > 0) { o.add += n; o.notes.push(`+${n} dado(s) pelo tamanho`); } }
  if (sp.sizeDice === "target") { const n = rules.sizeRank(tSheet.pkmn) - 2; if (n) { o.add += n; o.notes.push(`${n > 0 ? "+" : ""}${n} dado(s) pelo tamanho do alvo`); } }
  if (sp.knockOff && tSheet.pkmn.item && !tb.itemLost) { o.groups = 1; o.notes.push("alvo com item: dano aumentado"); }
  return o;
}

// fixed damage (ignores dice, STAB, crit, resistances; still 0 on a type immunity)
export function fixedDamage(rules, aSheet, tSheet, sp, aItem, tItem) {
  const lvl = rules.level(aSheet.pkmn), prof = rules.proficiency(aSheet.pkmn);
  if (sp.fixed === "lvlProf") return lvl + prof;
  if (typeof sp.fixed === "number") return sp.fixed;
  if (sp.fixed === "halfHp") return Math.min(2 * lvl, Math.floor((tSheet?.pkmn.hp.current ?? 0) / 2));
  if (sp.fixed === "counter") {
    const lh = aSheet.battle?.lastHit;
    if (!lh || lh.by !== tItem.id) return 0;
    const k = sp.name === "Metal Burst" || sp.name === "Comeuppance" ? 1.5 : 2;
    if (sp.name === "Counter" && !lh.melee) return 0;
    if (sp.name === "Mirror Coat" && lh.melee) return 0;
    return Math.min(5 * lvl, Math.floor(lh.amount * k));
  }
  return null;
}

// a multi-strike table result -> extra strikes (Skill Link: always 4)
export const extraStrikes = (n, skillLink) => (skillLink ? 4 : MULTI_TABLE(n));

// the weather table of Moonlight / Morning Sun / Synthesis
export function tableHeal(raw, levelIndex, weather) {
  const rows = raw?.Table?.Rows ?? [];
  const row = weather === "sun" ? rows[1] : ["rain", "hail", "sand", "snow"].includes(weather) ? rows[2] : rows[0];
  const col = { 1: 1, 5: 2, 10: 3, 17: 4 }[levelIndex] ?? 1;
  const m = /(\d+)d(\d+)/.exec(row?.[col] ?? "2d6");
  return { amount: Number(m[1]), sides: Number(m[2]) };
}
// Present: d20 -> damage dice or healing
export function presentRoll(raw, levelIndex) {
  const n = d(20);
  const rows = raw?.Table?.Rows ?? [];
  const col = { 1: 2, 5: 3, 10: 4, 17: 5 }[levelIndex] ?? 2;
  const row = rows.find((r) => { const [a, b] = r[0].split("-").map(Number); return n >= a && n <= (b ?? a); }) ?? rows[0];
  const m = /(\d+)d(\d+)/.exec(row?.[col] ?? "2d4");
  return { n, heal: /cura/i.test(row?.[1] ?? ""), amount: Number(m[1]), sides: Number(m[2]) };
}

// ------------------------------------------------------------------ turn hooks
// end of a Pokémon's own turn (inside its updateSheet): counters of these moves. Returns notes and
// cross effects ({ seedHeal: { by, amount } }) the caller applies to other tokens.
export function endTurnMoves(rules, sheet, { conditionGive }) {
  const b = sheet.battle;
  const notes = [];
  const cross = {};
  const pk = sheet.pkmn;
  const lvl = rules.level(pk);
  const magic = rules.abilities(pk).includes("Magic Guard") || sheet.battle?.ability === "Magic Guard";
  const hurt = (n, why) => { if (magic || pk.hp.current <= 0) return; pk.hp.current = Math.max(0, pk.hp.current - n); notes.push(`${why}: −${n} HP`); };
  if (b.seeded && pk.hp.current > 0 && !rules.types(pk).includes("Grass")) {
    const n = lvlHalf(lvl);
    const before = pk.hp.current;
    hurt(n, "🌱 Leech Seed");
    cross.seedHeal = { by: b.seeded.by, team: b.seeded.team, amount: before - pk.hp.current };
  }
  if (b.cursed) hurt(Math.max(2, lvl), "👻 Curse");
  // Wrap / Bind / Clamp / Snap Trap / Thunder Cage / Octolock: while still held by that one
  if (b.bound) {
    if (b.cond?.Grappled?.by === b.bound.by) {
      hurt(lvlHalf(lvl), `🤼 ${b.bound.move}`);
      if (b.bound.octo) {
        for (const k of ["Defense", "SpecialDefense"]) { pk.stages = Array.isArray(pk.stages) || !pk.stages ? {} : pk.stages; pk.stages[k] = Math.max(-6, (pk.stages[k] ?? 0) - 1); }
        notes.push("Octolock: Defesa e Defesa Especial −1");
      }
    } else delete b.bound;
  }
  if (b.perish != null) {
    b.perish -= 1;
    if (b.perish <= 0) {
      delete b.perish;
      if (b.perishLevelOver) hurt(5 * lvl, "🎵 Perish Song");
      else if (pk.hp.current > 0) { pk.hp.current = 0; notes.push("🎵 Perish Song: desmaiou"); }
    } else notes.push(`🎵 Perish Song: ${b.perish}`);
  }
  if (b.yawn != null) {
    b.yawn -= 1;
    if (b.yawn <= 0) { delete b.yawn; const r = conditionGive("Asleep"); notes.push(r.ok ? "🥱 Yawn: dormiu" : `Yawn: ${r.reason}`); }
  }
  if (b.wish != null) {
    b.wish.turns -= 1;
    if (b.wish.turns <= 0) {
      const heal = b.wish.amount;
      pk.hp.current = Math.min(rules.maxHP(pk), pk.hp.current + heal);
      notes.push(`⭐ Wish: +${heal} HP`);
      delete b.wish;
    }
  }
  if (b.locked) {
    b.locked.left -= 1;
    if (b.locked.left <= 0) { const mv = b.locked.move; delete b.locked; const r = conditionGive("Confused"); notes.push(`${mv} acabou${r.ok ? ": ficou confuso" : ""}`); }
  }
  if (b.restrict) {
    for (const [k, v] of Object.entries(b.restrict)) {
      v.turns -= 1;
      if (v.turns <= 0) { delete b.restrict[k]; notes.push(`${{ taunt: "Taunt", encore: "Encore", disable: "Disable", torment: "Torment", healBlock: "Heal Block" }[k] ?? k} acabou`); }
    }
    if (!Object.keys(b.restrict).length) delete b.restrict;
  }
  if (b.disabled) { b.disabled.turns -= 1; if (b.disabled.turns <= 0) { notes.push(`${b.disabled.move} desbloqueado`); delete b.disabled; } }
  if (b.charged && b.chargedUntil != null && (b.turns ?? 0) >= b.chargedUntil) delete b.charged;
  if (b.roosted) delete b.roosted;
  if (b.magnetRise != null) { b.magnetRise -= 1; if (b.magnetRise <= 0) { delete b.magnetRise; notes.push("Magnet Rise acabou"); } }
  return { notes, cross };
}

// start of a Pokémon's own turn on this field: weather damage, Electric Terrain wakes, Psychic
// Terrain takes the bonus action (inside its updateSheet). abilities: the Pokémon's.
export function startTurnField(rules, sheet, field, abilities, grounded, { clearCondition }) {
  const notes = [];
  const pk = sheet.pkmn;
  if (pk.hp.current <= 0) return notes;
  const types = rules.types(pk);
  const prof = rules.proficiency(pk);
  const magic = abilities.includes("Magic Guard") || abilities.includes("Overcoat");
  if (field.weather === "sand" && !types.some((t) => ["Rock", "Steel", "Ground"].includes(t)) && !magic
    && !["Sand Veil", "Sand Rush", "Sand Force"].some((a) => abilities.includes(a))) {
    pk.hp.current = Math.max(0, pk.hp.current - prof); notes.push(`🌪️ tempestade de areia: −${prof} HP`);
  }
  if (field.weather === "hail" && !types.includes("Ice") && !magic && !["Ice Body", "Snow Cloak", "Slush Rush"].some((a) => abilities.includes(a))) {
    pk.hp.current = Math.max(0, pk.hp.current - prof); notes.push(`🌨️ granizo: −${prof} HP`);
  }
  if (grounded && field.terrain === "electric") {
    if (clearCondition(sheet, "Asleep")) notes.push("⚡ Electric Terrain: acordou");
    if (clearCondition(sheet, "Drowsy")) notes.push("⚡ Electric Terrain: não está mais sonolento");
  }
  if (grounded && field.terrain === "psychic") { sheet.battle.econ = { ...(sheet.battle.econ ?? {}), bonus: false }; notes.push("🔮 Psychic Terrain: sem ação bônus"); }
  return notes;
}
// end of its turn on Grassy Terrain: heals the proficiency
export function grassyHeal(rules, sheet, field, grounded) {
  if (!grounded || field.terrain !== "grassy" || sheet.pkmn.hp.current <= 0) return null;
  const n = rules.proficiency(sheet.pkmn);
  const max = rules.maxHP(sheet.pkmn);
  if (sheet.pkmn.hp.current >= max) return null;
  sheet.pkmn.hp.current = Math.min(max, sheet.pkmn.hp.current + n);
  return `🌿 Grassy Terrain: +${n} HP`;
}
