// PMP battle rules from the "Livro de Regras - Pokémon Mundo Perfeito":
//   - Condições de Status (pág. 72): damage at the end of the turn, d6 rolls, immunities,
//     one non-volatile at a time, "Período de Carência".
//   - Mudanças de Status (pág. 73): stages -6..+6 stored like the app (pkmn.stages).
//   - Ações (pág. 47-49): action / bonus action / reaction per round, turns from Pretty Sordid.
//   - Effects of status moves, read from the move text.
//
// Battle state lives in sheet.battle (not in the app's JSON, so the export stays importable):
//   { cond: { Burning: { since, age, ... } }, grace: { key: ownTurnNumber }, turns,
//     econ: { action, bonus, reaction, loseAction }, paraLock }
import { OBR, SDK, ID, SHEET_KEY, getSheet, updateSheet, pushLog } from "./store.js?v=0.7.0";
import { d } from "./rules.js?v=0.7.0";

// ------------------------------------------------------------------ conditions

export const CONDITIONS = {
  Burning: { label: "Queimado", icon: "🔥", nonVolatile: true, immune: ["Fire"], app: "Burning" },
  Frozen: { label: "Congelado", icon: "🧊", nonVolatile: true, immune: ["Ice"], app: "Frozen" },
  Paralyzed: { label: "Paralisado", icon: "⚡", nonVolatile: true, immune: ["Electric"], app: "Paralyzed" },
  Poisoned: { label: "Envenenado", icon: "☠️", nonVolatile: true, immune: ["Poison", "Steel"], app: "Poisoned" },
  BadlyPoisoned: { label: "Gravemente Envenenado", icon: "☣️", nonVolatile: true, immune: ["Poison", "Steel"], app: "Poisoned" },
  Drowsy: { label: "Sonolento", icon: "🥱", nonVolatile: true, immune: [] },
  Asleep: { label: "Dormindo", icon: "💤", nonVolatile: true, immune: [], app: "Asleep" },
  Stunned: { label: "Atordoado", icon: "💫", nonVolatile: false, immune: [] },
  Confused: { label: "Confuso", icon: "😵‍💫", nonVolatile: false, immune: [], app: "Confused" },
  Infatuated: { label: "Encantado", icon: "💘", nonVolatile: false, immune: [] },
};

// conditions that leave the Pokémon incapacitated and "impedido" (attacks against it have advantage)
const INCAPACITATING = ["Frozen", "Asleep", "Stunned"];

export const conditionsOf = (sheet) => {
  if (sheet?.battle?.cond) return { ...sheet.battle.cond };
  // a sheet that never went through the battle rules: start from the app's statuses
  // (once battle.cond exists, pkmn.statuses is only the export copy and is not read back)
  const cond = {};
  for (const k of Object.keys(sheet?.pkmn?.statuses ?? {})) if (CONDITIONS[k]) cond[k] = { since: 0, age: 0 };
  return cond;
};
export const has = (sheet, key) => !!conditionsOf(sheet)[key];

// keeps the app's statuses (only the 6 it knows) in step, for the export
function syncAppStatuses(sheet) {
  const st = {};
  for (const k of Object.keys(sheet.battle.cond ?? {})) if (CONDITIONS[k]?.app) st[CONDITIONS[k].app] = true;
  sheet.pkmn.statuses = st;
}

// tries to give a condition; returns { ok, reason } (the draft is changed in place)
export function giveCondition(sheet, key, rules, { ownTurn = false } = {}) {
  const c = CONDITIONS[key];
  if (!c) return { ok: false, reason: "condição desconhecida" };
  sheet.battle ??= {};
  sheet.battle.cond = conditionsOf(sheet);
  const cond = sheet.battle.cond;
  const types = rules.types(sheet.pkmn);
  if (c.immune.some((t) => types.includes(t))) return { ok: false, reason: `imune (tipo ${types.join("/")})` };
  const grace = sheet.battle.grace?.[key];
  if (grace != null && (sheet.battle.turns ?? 0) <= grace) return { ok: false, reason: "período de carência" };
  if (cond[key]) {
    if (key === "Drowsy") { delete cond.Drowsy; cond.Asleep = { since: sheet.battle.turns ?? 0, age: 0 }; syncAppStatuses(sheet); return { ok: true, became: "Asleep" }; }
    if (key === "Infatuated") return { ok: false, reason: "já está encantado" };
    return { ok: false, reason: "já está assim" };
  }
  if (c.nonVolatile) {
    const other = Object.keys(cond).find((k) => CONDITIONS[k]?.nonVolatile);
    // Poisoned -> BadlyPoisoned is an upgrade; anything else is blocked by the current one
    if (other && !(other === "Poisoned" && key === "BadlyPoisoned")) return { ok: false, reason: `já está ${CONDITIONS[other].label}` };
    if (other) delete cond[other];
  }
  const entry = { since: sheet.battle.turns ?? 0, age: 0 };
  if (key === "Confused") entry.left = d(4) + 1; // 1d4 + 1 turns
  if (key === "BadlyPoisoned") entry.count = 1;
  if (key === "Stunned") entry.untilEnd = !ownTurn; // out of its turn: until the end of its next turn
  cond[key] = entry;
  syncAppStatuses(sheet);
  return { ok: true };
}

// ends a condition and starts its "Período de Carência" (immune until the end of its next turn)
export function clearCondition(sheet, key, { grace = true } = {}) {
  sheet.battle ??= {};
  sheet.battle.cond ??= {};
  if (!sheet.battle.cond[key] && !sheet.pkmn.statuses?.[key]) return false;
  delete sheet.battle.cond[key];
  if (grace) {
    sheet.battle.grace ??= {};
    sheet.battle.grace[key] = (sheet.battle.turns ?? 0) + 1;
  }
  if (key === "Asleep") delete sheet.battle.cond.Drowsy; // waking up also cures Sonolento
  syncAppStatuses(sheet);
  return true;
}

// ------------------------------------------------------------------ stages (pág. 73)

export const STAGES = {
  Attack: "Ataque", SpecialAttack: "Ataque Especial", Defense: "Defesa", SpecialDefense: "Defesa Especial",
  Speed: "Velocidade", Accuracy: "Precisão", Evasion: "Evasão", CritMargin: "Margem de Crítico",
};
export const STAGE_SHORT = { Attack: "Atq", SpecialAttack: "AtE", Defense: "Def", SpecialDefense: "DfE", Speed: "Vel", Accuracy: "Prec", Evasion: "Eva", CritMargin: "Crít" };

export const stage = (pkmn, key) => pkmn?.stages?.[key] ?? 0;
export function addStage(pkmn, key, delta) {
  const [min, max] = key === "CritMargin" ? [0, 6] : [-6, 6]; // Margem de Crítico can't go down
  pkmn.stages ??= {};
  const v = Math.max(min, Math.min(max, stage(pkmn, key) + delta));
  if (v === 0) delete pkmn.stages[key]; else pkmn.stages[key] = v;
  return v;
}

// ------------------------------------------------------------------ reading a move's effects

const STAT_WORDS = [
  ["Ataque Especial", "SpecialAttack"], ["Defesa Especial", "SpecialDefense"], ["Ataque", "Attack"], ["Defesa", "Defense"],
  ["Velocidade", "Speed"], ["Precisão", "Accuracy"], ["Precisao", "Accuracy"], ["Evasão", "Evasion"], ["Evasao", "Evasion"],
  ["Margem de Crítico", "CritMargin"], ["Margem de Critico", "CritMargin"],
];
const STATUS_WORDS = [
  [/gravemente envenenad/i, "BadlyPoisoned"], [/envenenad/i, "Poisoned"], [/queimad/i, "Burning"], [/paralisad/i, "Paralyzed"],
  [/congelad/i, "Frozen"], [/sonolent/i, "Drowsy"], [/\b(dorme|dormindo|adormec)/i, "Asleep"], [/confus/i, "Confused"],
  [/encantad/i, "Infatuated"], [/atordoad/i, "Stunned"],
];
const ATTR = { FOR: "STR", DES: "DEX", CON: "CON", INT: "INT", SAB: "WIS", CAR: "CHA" };

const statsInText = (seg) => {
  const stats = [];
  for (const [word, key] of STAT_WORDS) {
    if (seg.includes(word)) { stats.push(key); seg = seg.replaceAll(word, ""); }
  }
  return stats;
};
const UP = /^(aument|eleva|ganh)/i;

function stagesIn(sentence) {
  const out = [];
  // the rulebook text has broken words ("re duzindo"): glue the common ones back
  const s = sentence.replace(/r\s?e\s?duz/gi, "reduz").replace(/au\s?ment/gi, "aument").replace(/dimi\s?nu/gi, "diminu");
  // "aumentando seu Ataque e Defesa em 1 estágio", "reduzindo a Defesa em 2 estágios"
  const verbFirst = /(aument\w*|eleva\w*|ganha\w*|reduz\w*|diminu\w*|abaix\w*|perde\w*)([^.]*?)em (\d+) est[aá]gios?/gi;
  let m;
  while ((m = verbFirst.exec(s))) {
    for (const key of statsInText(m[2])) out.push({ stat: key, delta: (UP.test(m[1]) ? 1 : -1) * Number(m[3]) });
  }
  if (out.length) return out;
  // "tem seu Ataque reduzido em 2 estágios", "a Defesa do alvo é reduzida em 2 estágios"
  const statFirst = /([A-ZÁÉÍÓÚ][^.]*?)\b(reduzid\w*|aumentad\w*|diminu[ií]d\w*|elevad\w*|abaixad\w*) em (\d+) est[aá]gios?/g;
  while ((m = statFirst.exec(s))) {
    for (const key of statsInText(m[1])) out.push({ stat: key, delta: (/^(aument|elevad)/i.test(m[2]) ? 1 : -1) * Number(m[3]) });
  }
  return out;
}

function statusIn(sentence) {
  // "fica Queimado", "o alvo fica Paralisado", "é envenenada", "ficando paralisado" (no \b: it fails next to accents)
  if (!/(^|\s)(fica|ficar|ficará|ficando|torna|é|será|cai no sono|dorme|adormec)/i.test(sentence)) return null;
  for (const [re, key] of STATUS_WORDS) if (re.test(sentence)) return key;
  return null;
}

// { self: [stages], target: { onHit|onFail|direct: [...] }, contest, natural }
export function moveEffects(move) {
  const desc = (move.Description ?? "").replace(/\s+/g, " ");
  const sentences = desc.split(/(?<=[.!?])\s+/);
  const pessoal = /^pessoal/i.test((move.Range ?? "").trim());
  const area = /cone|linha|raio|semic/i.test(move.Range ?? "");
  const fx = { self: [], fail: [], direct: [], natural: null, contest: null, statusFail: null, statusDirect: null };
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const contest = s.match(/Role 1d20 \+ MOVE \+ (\d+) e compare o resultado com 10 \+ (FOR|DES|CON|INT|SAB|CAR)/i);
    if (contest) {
      // the result is in the same sentence or the next one ("Em um resultado maior ou igual, o alvo fica X")
      const next = sentences[i + 1] ?? "";
      const status = statusIn(s) ?? statusIn(next);
      const stages = [...stagesIn(s), ...stagesIn(next)];
      fx.contest = { bonus: Number(contest[1]), attr: ATTR[contest[2].toUpperCase()], status, stages, autoType: /tipo (\w+), ele acerta automaticamente/i.exec(desc)?.[1] ?? null };
      if (/resultado maior ou igual|em caso de sucesso/i.test(next)) i++; // already read
      continue;
    }
    const nat = s.match(/resultado natural de (\d+)/i);
    if (nat) {
      fx.natural = { min: Number(nat[1]), status: statusIn(s), stages: stagesIn(s) };
      continue;
    }
    const stages = stagesIn(s);
    const status = statusIn(s);
    const onFail = /falha|falhar/i.test(s) && move.Save;
    const selfish = /\b(seu|sua|seus|suas|voc[eê])\b[^.]*est[aá]gio/i.test(s) && !/\bdo alvo\b|\bda criatura\b|\bo alvo\b/i.test(s);
    for (const st of stages) {
      if (onFail) fx.fail.push(st);
      else if ((pessoal && !area) || selfish) fx.self.push(st);
      else fx.direct.push(st);
    }
    if (status) {
      if (onFail) fx.statusFail ??= status;
      else if (!move.Damage && !move.atk && !(pessoal && !area)) fx.statusDirect ??= status;
    }
  }
  return fx;
}

// ------------------------------------------------------------------ action economy (pág. 47-49)

// what a "Move Time" allows: { action, bonus, reaction, both }
export function moveTiming(move) {
  const t = (move["Move Time"] ?? "").toLowerCase();
  // "1 ação / reação", "1 ação + ação bônus", "1 ação, recarga": look at each piece
  // ("reação" contains "ação", so a plain search would count every reaction as an action)
  const pieces = t.split(/[\/+,]/).map((p) => p.trim().replace(/^1\s*/, ""));
  const isAction = (p) => /^(a[cç][aã]o|action)s?$/.test(p);
  return {
    action: !t || pieces.some(isAction),
    bonus: pieces.some((p) => /b[oô]nus/.test(p)),
    reaction: pieces.some((p) => /^rea[cç][aã]o/.test(p)),
    both: /a[cç][aã]o\s*\+\s*a[cç][aã]o b[oô]nus/.test(t),
    losesNextAction: /perde a a[cç][aã]o padr[aã]o|abre m[aã]o de sua a[cç][aã]o padr[aã]o/i.test(move.Description ?? ""),
  };
}

export const PRETTY = "com.pretty-initiative/metadata";
export const inInitiative = (item) => typeof item?.metadata?.[PRETTY]?.count === "string";
export const isActive = (item) => item?.metadata?.[PRETTY]?.active === true;
export const econOf = (sheet) => ({ action: true, bonus: true, reaction: true, ...(sheet?.battle?.econ ?? {}) });

export class TurnError extends Error {}

// decides which action a move spends right now, or throws TurnError
// combatRunning: someone is active in Pretty Sordid
export function chooseCost(item, move, combatRunning) {
  if (!combatRunning || !inInitiative(item)) return null; // free play: nothing is tracked
  const sheet = getSheet(item);
  const econ = econOf(sheet);
  const t = moveTiming(move);
  const own = isActive(item);
  if (sheet.battle?.paraLock) throw new TurnError("Paralisado: perdeu as ações até o próximo turno.");
  if (own) {
    if (t.both) {
      if (econ.action && econ.bonus) return { spend: ["action", "bonus"], label: "ação + ação bônus" };
      throw new TurnError("Esse Move precisa da ação e da ação bônus, e uma delas já foi usada.");
    }
    if (t.action && econ.action) return { spend: ["action"], label: "ação" };
    if (t.bonus && econ.bonus) return { spend: ["bonus"], label: "ação bônus" };
    if (t.reaction && econ.reaction && !has(sheet, "Confused")) return { spend: ["reaction"], label: "reação", reaction: true, losesNextAction: t.losesNextAction };
    throw new TurnError(t.bonus && !t.action ? "A ação bônus deste turno já foi usada." : "A ação deste turno já foi usada.");
  }
  if (!t.reaction) throw new TurnError("Não é o turno deste Pokémon (só Moves de reação podem ser usados fora do turno).");
  if (has(sheet, "Confused")) throw new TurnError("Confuso: não pode usar reações.");
  if (!econ.reaction) throw new TurnError("A reação já foi usada (volta no início do próximo turno deste Pokémon).");
  return { spend: ["reaction"], label: "reação", reaction: true, losesNextAction: t.losesNextAction };
}

export function spend(sheet, cost) {
  if (!cost) return;
  sheet.battle ??= {};
  sheet.battle.econ = { ...econOf(sheet) };
  for (const k of cost.spend) sheet.battle.econ[k] = false;
  if (cost.losesNextAction) sheet.battle.econ.loseAction = true;
}

// ------------------------------------------------------------------ before a move: can it act at all?

// returns { canAct, checks: [{ label, nat, failed }], reason, selfDamage, keepsAction }
// rolls go through the given roller in one throw
export async function statusGate(rules, item, roller) {
  const sheet = getSheet(item);
  const cond = conditionsOf(sheet);
  if (cond.Frozen) return { canAct: false, reason: "Congelado: não pode agir." };
  if (cond.Asleep) return { canAct: false, reason: "Dormindo: não pode agir." };
  if (cond.Stunned) return { canAct: false, reason: "Atordoado: não pode agir." };
  if (sheet.battle?.paraLock) return { canAct: false, reason: "Paralisado: travou até o próximo turno." };
  if (cond.Drowsy?.blocked) return { canAct: false, reason: "Sonolento: neste turno não consegue usar Moves." };
  const parts = [];
  if (cond.Paralyzed) parts.push({ key: "Paralyzed", amount: 1, sides: 4, bonus: 0 });
  if (cond.Confused) parts.push({ key: "Confused", amount: 1, sides: 6, bonus: 0 });
  if (cond.Infatuated) parts.push({ key: "Infatuated", amount: 1, sides: 4, bonus: 0 });
  if (!parts.length) return { canAct: true, checks: [] };
  const rolled = await roller.batch(parts, `${item.name} — condições`);
  const checks = [];
  for (let i = 0; i < parts.length; i++) {
    const nat = rolled[i].dice[0];
    const key = parts[i].key;
    if (key === "Paralyzed") {
      checks.push({ label: "Paralisia (d4)", nat, failed: nat === 1 });
      if (nat === 1) return { canAct: false, checks, reason: "Paralisado: o corpo travou (1 no d4). O Move falha, sem gastar PP, e o Pokémon perde as ações até o próximo turno.", paraLock: true };
    }
    if (key === "Confused") {
      checks.push({ label: "Confusão (d6)", nat, failed: nat >= 5 });
      if (nat >= 5) {
        const lvl = rules.level(sheet.pkmn);
        const str = Math.floor((rules.attributes(sheet.pkmn).STR - 10) / 2);
        const dmg = Math.max(2, Math.floor(lvl / 2)) + str;
        return { canAct: false, checks, reason: `Confuso (${nat} no d6): se atrapalhou e tomou ${dmg} de dano. O Move falha, sem gastar PP, mas a ação é gasta.`, selfDamage: Math.max(0, dmg), spendsAction: true };
      }
    }
    if (key === "Infatuated") {
      checks.push({ label: "Encanto (d4)", nat, failed: nat <= 2 });
      if (nat <= 2) return { canAct: false, checks, reason: `Encantado (${nat} no d4): o Move falha, sem gastar PP, mas a ação é gasta.`, spendsAction: true };
    }
  }
  return { canAct: true, checks };
}

// ------------------------------------------------------------------ roll modifiers from conditions/stages

// attack roll against target: advantage if the target is incapacitated/impedido
export function attackAdvantage(attackerSheet, targetSheet) {
  const t = conditionsOf(targetSheet);
  return INCAPACITATING.some((k) => t[k]) ? 1 : 0;
}

// saving throw of the target: -1 = disadvantage
export function saveAdvantage(targetSheet, attr) {
  const t = conditionsOf(targetSheet);
  if (t.Asleep) return -1;
  if ((t.Paralyzed || t.Frozen || t.Stunned) && attr === "DEX") return -1;
  if ((t.Poisoned || t.BadlyPoisoned) && attr === "CON") return -1;
  return 0;
}

// ------------------------------------------------------------------ turns (run on the GM's browser)

const TURN_KEY = `${ID}/turn`;

async function battleItems() {
  return OBR.scene.items.getItems((i) => i.metadata?.[SHEET_KEY] != null);
}

function damageNow(sheet, n) {
  const hp = sheet.pkmn.hp;
  hp.current = Math.max(0, hp.current - Math.max(0, n));
}

// end of a Pokémon's turn: condition damage, sleep rolls, counters
export async function endTurn(rules, item) {
  const notes = [];
  const sleepRoll = has(getSheet(item), "Asleep") ? d(6) : null;
  await updateSheet(item.id, (sheet) => {
    const b = sheet.battle;
    b.turns = (b.turns ?? 0) + 1;
    const cond = conditionsOf(sheet);
    b.cond = cond;
    const prof = rules.proficiency(sheet.pkmn);
    const lvl = rules.level(sheet.pkmn);
    const wasUp = sheet.pkmn.hp.current > 0;
    if (wasUp) {
      if (cond.Burning) { damageNow(sheet, prof); notes.push(`🔥 Queimado: −${prof} HP`); }
      if (cond.Poisoned) { const n = Math.max(2, Math.ceil(lvl / 2)); damageNow(sheet, n); notes.push(`☠️ Envenenado: −${n} HP`); }
      if (cond.BadlyPoisoned) {
        const c = cond.BadlyPoisoned.count ?? 1;
        damageNow(sheet, prof * c); notes.push(`☣️ Gravemente Envenenado (${c}º turno): −${prof * c} HP`);
        cond.BadlyPoisoned.count = c + 1;
      }
    }
    if (cond.Asleep) {
      const age = (cond.Asleep.age ?? 0) + 1;
      cond.Asleep.age = age;
      const need = age >= 3 ? 1 : age === 2 ? 4 : 5;
      if (sleepRoll >= need) { clearCondition(sheet, "Asleep"); notes.push(`💤 Acordou (${sleepRoll} no d6)`); }
      else notes.push(`💤 Continua dormindo (${sleepRoll} no d6, precisava ${need}+)`);
    }
    if (cond.Confused) {
      cond.Confused.left = (cond.Confused.left ?? 1) - 1;
      if (cond.Confused.left <= 0) { clearCondition(sheet, "Confused"); notes.push("😵‍💫 Não está mais confuso"); }
    }
    if (cond.Stunned?.untilEnd) { clearCondition(sheet, "Stunned"); notes.push("💫 Não está mais atordoado"); }
    // "Período de Carência" lasts until the end of its next turn
    for (const [k, until] of Object.entries(b.grace ?? {})) if (b.turns > until) delete b.grace[k];
    syncAppStatuses(sheet);
    if (wasUp && sheet.pkmn.hp.current <= 0) notes.push("😵 Desmaiou");
  });
  return notes;
}

// start of a Pokémon's turn: reaction back, frozen/drowsy/stunned
export async function startTurn(rules, item) {
  const notes = [];
  const thawRoll = has(getSheet(item), "Frozen") ? d(6) : null;
  await updateSheet(item.id, (sheet) => {
    const b = sheet.battle;
    const cond = conditionsOf(sheet);
    b.cond = cond;
    b.econ = { ...econOf(sheet), reaction: true };
    if (b.paraLock) { delete b.paraLock; }
    if (b.econ.loseAction) { b.econ.action = false; b.econ.loseAction = false; notes.push("perdeu a ação padrão deste turno (usou reação)"); }
    if (cond.Frozen) {
      const age = (cond.Frozen.age ?? 0) + 1;
      cond.Frozen.age = age;
      const need = Math.max(1, 7 - age); // 6 on the 1st turn, then 5, 4...
      if (thawRoll >= need) { clearCondition(sheet, "Frozen"); notes.push(`🧊 Descongelou (${thawRoll} no d6) e pode agir`); }
      else notes.push(`🧊 Continua congelado (${thawRoll} no d6, precisava ${need}+)`);
    }
    if (cond.Stunned && !cond.Stunned.untilEnd) { clearCondition(sheet, "Stunned"); notes.push("💫 Não está mais atordoado"); }
    if (cond.Drowsy) {
      const age = (cond.Drowsy.age ?? 0) + 1;
      cond.Drowsy.age = age;
      // 1st turn: acts normally; from the 2nd: blocked, free, blocked...
      cond.Drowsy.blocked = age >= 2 && age % 2 === 0;
      if (cond.Drowsy.blocked) notes.push("🥱 Sonolento: neste turno não consegue usar Moves");
    }
    syncAppStatuses(sheet);
  });
  return notes;
}

// a new round: action and bonus action come back for everyone in the initiative;
// a Helping Hand nobody used expires
export async function newRound(items) {
  for (const it of items) {
    if (!inInitiative(it) && !getSheet(it)?.battle?.helped) continue;
    await updateSheet(it.id, (sheet) => {
      sheet.battle.econ = { ...econOf(sheet), action: true, bonus: true };
      delete sheet.battle.helped;
    });
  }
}

// end of combat: stages reset, volatile conditions end, Gravemente Envenenado -> Envenenado
export async function endCombat(items) {
  for (const it of items) {
    await updateSheet(it.id, (sheet) => {
      const cond = conditionsOf(sheet);
      for (const k of Object.keys(cond)) if (!CONDITIONS[k]?.nonVolatile) delete cond[k];
      if (cond.BadlyPoisoned) { delete cond.BadlyPoisoned; cond.Poisoned = { since: 0, age: 0 }; }
      if (cond.Drowsy) delete cond.Drowsy;
      sheet.battle = { cond };
      sheet.pkmn.stages = {};
      delete sheet.pkmn.damage_amp; // like the app's reset_battle_stages
      delete sheet.pkmn.damage_red;
      syncAppStatuses(sheet);
    });
  }
}

// watches Pretty Sordid and runs the turn hooks once (GM only); state kept in the scene
export function watchTurns(rules) {
  let busy = false, again = false;
  const tick = async () => {
    if (busy) { again = true; return; } // a turn change while busy: run again right after
    busy = true;
    try {
      const items = await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY] != null);
      const active = items.find(isActive);
      const meta = await OBR.scene.getMetadata();
      const round = Number(meta["com.pretty-initiative/roundCount"] ?? 1);
      const prev = meta[TURN_KEY] ?? {};
      if (!active) return;
      if (prev.activeId === active.id && prev.round === round) return;
      await OBR.scene.setMetadata({ [TURN_KEY]: { activeId: active.id, round } });
      const sheets = await battleItems();
      const byId = new Map(sheets.map((s) => [s.id, s]));
      const log = [];
      if (prev.activeId && prev.activeId !== active.id && byId.has(prev.activeId)) {
        const notes = await endTurn(rules, byId.get(prev.activeId));
        if (notes.length) log.push(`Fim do turno de ${byId.get(prev.activeId).name}: ${notes.join("; ")}`);
      }
      if (prev.round != null && round !== prev.round) await newRound(sheets);
      if (byId.has(active.id)) {
        const notes = await startTurn(rules, (await OBR.scene.items.getItems([active.id]))[0]);
        log.push(`Turno de ${active.name}${notes.length ? `: ${notes.join("; ")}` : ""}`);
      }
      for (const text of log) await pushLog({ kind: "note", attacker: "Combate", text });
    } finally {
      busy = false;
      if (again) { again = false; tick(); }
    }
  };
  OBR.scene.items.onChange(() => tick());
  OBR.scene.onMetadataChange(() => tick());
  tick();
}

// ------------------------------------------------------------------ teams and who sees what

export const TEAMS = { jogadores: "Jogadores", inimigos: "Inimigos", neutros: "Neutros" };
export const teamOf = (sheet) => sheet?.team ?? "inimigos";
export const allies = (a, b) => teamOf(a) === teamOf(b);

// full sheet (HP numbers, AC, moves) for: the GM, the owner, and the players' own team
export const canSeeFull = (sheet, viewer) => viewer.role === "GM" || sheet?.owner === viewer.id || teamOf(sheet) === "jogadores";

// ------------------------------------------------------------------ damage points (pág. 57-58), like the app

export const ampPoints = (pkmn) => pkmn?.damage_amp ?? 0;
export const redPoints = (pkmn) => pkmn?.damage_red ?? 0;
export function setPoints(pkmn, key, value) {
  const v = Math.max(0, Math.min(20, Math.round(value * 2) / 2));
  if (v) pkmn[key] = v; else delete pkmn[key];
}
export function pointsSummary(amp, red) {
  const a = Math.floor(amp), r = Math.floor(red);
  return {
    ampGroups: Math.floor(a / 2), ampReroll: a % 2 === 1, ampFlat: amp === 0.5,
    redHalvings: Math.floor(r / 2), redReroll: r % 2 === 1, redFlat: red === 0.5,
  };
}
// each group of 2 points: +1 die for every 2; an odd die left over gives +1/4 of its max (rounded up)
export function amplifyDice(amount, sides, groups) {
  let bonus = 0;
  for (let i = 0; i < groups; i++) {
    if (amount % 2 === 1) bonus += Math.ceil(sides / 4);
    amount += Math.floor(amount / 2);
  }
  return { amount, bonus };
}
export function pointsText(amp, red, amount = 4, sides = 8) {
  const s = pointsSummary(amp, red);
  const out = [];
  if (s.ampFlat) out.push("+½ prof. de dano");
  if (s.ampGroups) { const a = amplifyDice(amount, sides, s.ampGroups); out.push(`${amount}d${sides} → ${a.amount}d${sides}${a.bonus ? `+${a.bonus}` : ""}`); }
  if (s.ampReroll) out.push("rola o dano 2x e fica com o maior");
  if (s.redFlat) out.push("−½ prof. de dano");
  if (s.redReroll) out.push("rola o dano 2x e fica com o menor");
  if (s.redHalvings) out.push(`dano final ÷${2 ** s.redHalvings}`);
  return out.join(" · ");
}

// ------------------------------------------------------------------ token marks (GM only)
// HP bar + conditions/stages label under every Pokémon with a sheet, gray overlay when fainted,
// and fainted Pokémon leave the initiative.

const MARK = `${ID}/mark`;

const hpColor = (pct) => (pct > 0.5 ? "#46c37b" : pct > 0.25 ? "#f0b03f" : "#ef5d5d");

export function marksText(sheet) {
  const cond = conditionsOf(sheet);
  const parts = Object.keys(cond).map((k) => `${CONDITIONS[k]?.icon ?? ""} ${CONDITIONS[k]?.label ?? k}`);
  for (const [k, v] of Object.entries(sheet.pkmn.stages ?? {})) if (v) parts.push(`${v > 0 ? "▲" : "▼"} ${STAGE_SHORT[k] ?? k} ${v > 0 ? "+" : ""}${v}`);
  if (sheet.battle?.helped) parts.push("🤝 Helping Hand");
  return parts.join("  ");
}

// takes a fainted Pokémon out of Pretty Sordid (passing the turn on if it was its turn)
async function leaveInitiative(token) {
  const meta = await OBR.scene.getMetadata();
  const order = Object.values(meta["com.pretty-initiative/order"] ?? {});
  const wasActive = isActive(token);
  await OBR.scene.items.updateItems([token.id], (ds) => { for (const d0 of ds) delete d0.metadata[PRETTY]; });
  const rest = order.filter((id) => id !== token.id);
  const patch = { "com.pretty-initiative/order": Object.fromEntries(rest.map((id, i) => [i, id])) };
  if (wasActive && rest.length) {
    const idx = Math.max(0, order.indexOf(token.id));
    const nextId = order.slice(idx + 1).find((id) => rest.includes(id));
    const next = nextId ?? rest[0];
    if (!nextId) patch["com.pretty-initiative/roundCount"] = Number(meta["com.pretty-initiative/roundCount"] ?? 1) + 1;
    await OBR.scene.items.updateItems([next], (ds) => { for (const d0 of ds) if (d0.metadata[PRETTY]) d0.metadata[PRETTY].active = true; });
  }
  await OBR.scene.setMetadata(patch);
  await pushLog({ kind: "note", attacker: "Combate", text: `${token.name} desmaiou e saiu da iniciativa` });
}

export function watchMarks(rules) {
  let busy = false, again = false;
  const sync = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const all = await OBR.scene.items.getItems();
      const marks = all.filter((i) => i.metadata?.[MARK]);
      const tokens = all.filter((i) => i.metadata?.[SHEET_KEY]);
      const dpi = await OBR.scene.grid.getDpi();
      const want = [];
      for (const t of tokens) {
        const sheet = getSheet(t);
        const max = Math.max(1, rules.maxHP(sheet.pkmn));
        const hp = sheet.pkmn.hp?.current ?? 0;
        const pct = Math.max(0, Math.min(1, hp / max));
        const fainted = hp <= 0;
        if (fainted && inInitiative(t)) await leaveInitiative(t);
        const size = t.image && t.grid?.dpi ? (t.image.width / t.grid.dpi) * Math.abs(t.scale?.x ?? 1) * dpi : dpi;
        const base = { for: t.id, size, pos: t.position, visible: t.visible };
        const w = size * 0.8, hgt = Math.max(6, dpi * 0.07), top = t.position.y + size / 2 + dpi * 0.04;
        const left = t.position.x - w / 2;
        // the bar's fill is stepped to 5% so tiny HP changes don't rebuild it
        const step = Math.round(pct * 20) / 20;
        want.push({ ...base, kind: "barbg", x: left, y: top, w, h: hgt, key: `barbg:${t.id}:${Math.round(w)}:${t.visible}` });
        if (step > 0) want.push({ ...base, kind: "bar", x: left, y: top, w: w * step, h: hgt, color: hpColor(pct), key: `bar:${t.id}:${step}:${Math.round(w)}:${t.visible}` });
        if (fainted) want.push({ ...base, kind: "faint", key: `faint:${t.id}:${Math.round(size)}:${t.visible}` });
        const text = fainted ? "😵 Desmaiado" : marksText(sheet);
        if (text) want.push({ ...base, kind: "label", y: top + hgt + dpi * 0.04, text, key: `label:${t.id}:${text}:${t.visible}` });
      }
      const haveKeys = new Set(marks.map((m) => m.metadata[MARK].key));
      const wantKeys = new Set(want.map((x) => x.key));
      const remove = marks.filter((m) => !wantKeys.has(m.metadata[MARK].key)).map((m) => m.id);
      if (remove.length) await OBR.scene.items.deleteItems(remove);
      const { buildShape, buildLabel } = SDK;
      const add = [];
      const common = (b, x) => b.layer("ATTACHMENT").attachedTo(x.for).locked(true).disableHit(true).visible(x.visible).metadata({ [MARK]: { key: x.key } });
      for (const x of want) {
        if (haveKeys.has(x.key)) continue;
        if (x.kind === "faint") {
          add.push(common(buildShape().shapeType("CIRCLE").width(x.size * 0.95).height(x.size * 0.95).position(x.pos)
            .fillColor("#30303a").fillOpacity(0.62).strokeColor("#30303a").strokeOpacity(0.8).strokeWidth(dpi * 0.03), x).build());
        } else if (x.kind === "barbg" || x.kind === "bar") {
          add.push(common(buildShape().shapeType("RECTANGLE").width(x.w).height(x.h).position({ x: x.x, y: x.y })
            .fillColor(x.kind === "bar" ? x.color : "#1b1d27").fillOpacity(x.kind === "bar" ? 0.95 : 0.85)
            .strokeColor("#000000").strokeOpacity(x.kind === "bar" ? 0 : 0.6).strokeWidth(x.kind === "bar" ? 0 : 2), x).zIndex(x.kind === "bar" ? 2 : 1).build());
        } else {
          add.push(common(buildLabel().plainText(x.text).position({ x: x.pos.x, y: x.y })
            .backgroundColor("#1e2231").backgroundOpacity(0.85).fillColor("#ffffff").pointerDirection("UP"), x).build());
        }
      }
      if (add.length) await OBR.scene.items.addItems(add);
    } finally {
      busy = false;
      if (again) { again = false; sync(); }
    }
  };
  OBR.scene.items.onChange(() => sync());
  sync();
}
