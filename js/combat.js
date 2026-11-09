// Using a move, following the PMP rulebook:
//   1. turn/action check (Pretty Sordid) and the attacker's conditions (paralysis, confusion, charm)
//   2. ONE throw with every die: attacks (with advantage/Helping Hand), saves (with disadvantage),
//      status contests and damage
//   3. stages in to-hit/DC/AC/saves/damage, crit margin, natural 1/20 on saves, burn, type effectiveness
//   4. conditions and stage changes from the move text, written to the tokens
import { OBR, getSheet, updateSheet, pushLog, getSettings } from "./store.js?v=0.9.6";
import { TYPE_PT, ATTR_PT, signed, fmtM, d } from "./rules.js?v=0.9.6";
import { checkRange, OutOfRange, sendFx, distanceMeters } from "./map.js?v=0.9.6";
import { getRoller } from "./dice.js?v=0.9.6";
import { defenses, endure } from "./protect.js?v=0.9.6";
import { FORCE, SELF_SWITCH, TRAPS, happened, trap, bench, forceRandomSwitch } from "./trainer.js?v=0.9.6";
import {
  CONDITIONS, STAGES, conditionsOf, giveCondition, clearCondition, stage, addStage, moveEffects, chooseCost, spend,
  statusGate, attackAdvantage, saveAdvantage, isActive, inInitiative, econOf, PRETTY, TurnError,
  allies, teamOf, canSeeFull, ampPoints, redPoints, pointsSummary, amplifyDice, pointsText,
} from "./battle.js?v=0.9.6";
import {
  special, chargingOf, invulnOf, invulnText, invulnCheck, releaseReady, elevated, movement, jumpOpts, spendMovement,
  fall, approach, moveToken, checkSentinel, jumps,
} from "./tactics.js?v=0.9.6";

export { TurnError };

const effLabel = (m) => (m === 0 ? "imune" : m >= 4 ? "super efetivo ×4" : m >= 2 ? "super efetivo ×2" : m <= 0.25 ? "pouco efetivo ×¼" : m < 1 ? "pouco efetivo ×½" : "");
const mod = (v) => Math.floor((v - 10) / 2);
const stageText = (list) => list.map((s) => `${STAGES[s.stat]} ${s.delta > 0 ? "+" : ""}${s.delta}`).join(", ");

// Helping Hand's die: "d8 no nível 5, d10 no nível 10 e d12 no nível 17"
export const helpDie = (rules, pkmn) => { const l = rules.level(pkmn); return l >= 17 ? 12 : l >= 10 ? 10 : l >= 5 ? 8 : 6; };

// applies damage to a Pokémon JSON: temp HP first, never below 0
function takeDamage(pkmn, amount) {
  const temp = pkmn.hp.temp ?? 0;
  const fromTemp = Math.min(temp, amount);
  pkmn.hp.temp = temp - fromTemp;
  pkmn.hp.current = Math.max(0, pkmn.hp.current - (amount - fromTemp));
}

async function combatRunning() {
  const items = await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY] != null);
  return items.some(isActive);
}

// opts.ignoreRange: roll even with targets out of range (the player confirmed)
// opts.area: the targets came from an area template (no range check, damage rolled once for everyone)
// opts.force: the GM skips the turn/action check
// opts.helpers: Pokémon using Helping Hand on this move (their reaction)
export async function useMove(rules, attackerItem, moveName, targetItems, opts = {}) {
  const settings = await getSettings();
  const aSheet = getSheet(attackerItem);
  const attacker = aSheet.pkmn;
  const move = rules.moveData(attacker, moveName);
  const raw = rules.moves[moveName] ?? {};
  const fx = moveEffects(raw);
  const melee = move.rangeInfo.kind === "melee";
  const who = attackerItem.name || rules.name(attacker);
  const entry = { kind: "move", attacker: who, move: move.label, type: TYPE_PT[move.type] ?? move.type, area: opts.area ? move.rangeInfo.label : null, results: [], notes: [] };

  const running = await combatRunning();
  const tracked = running && inInitiative(attackerItem);
  const sp = special(rules, moveName);
  const charging = chargingOf(aSheet);
  const releasing = !!(charging && charging.move === moveName);
  // two-turn moves: this use only charges / vanishes / focuses (no targets, no roll)
  const activating = !!sp && ["invuln", "focus", "charge"].includes(sp.kind) && !releasing;
  if (invulnOf(aSheet) && !releasing) throw new TurnError(`${who} está ${invulnText(charging)}: só pode usar ${charging.move}.`);
  if (releasing && !releaseReady(aSheet, running)) throw new TurnError(`${charging.move} só pode ser liberado no próximo turno.`);
  if (moveName === "Fake Out" && running && !opts.force) {
    const round = Number((await OBR.scene.getMetadata())["com.pretty-initiative/roundCount"] ?? 1);
    if (round !== 1) throw new TurnError("Fake Out só pode ser usado na 1ª rodada do combate.", "round");
  }

  // (Struggle is the last resort of an attack of opportunity: no PP)
  if (!releasing && moveName !== "Struggle" && typeof move.pp === "number" && move.pp <= 0) throw new Error(`${move.label} está sem PP.`);

  // invulnerable targets (Fly, Dig...): only the right moves reach them
  const blocked = [];
  if (!activating) {
    for (const t of targetItems) {
      const inv = invulnCheck(getSheet(t), moveName);
      if (inv?.blocked) blocked.push({ t, reason: inv.reason });
    }
    if (blocked.length && !opts.area) throw new Error(blocked.map((b) => `${b.t.name} está ${b.reason}: não pode ser alvo`).join("; ") + ".");
    if (blocked.length) targetItems = targetItems.filter((t) => !blocked.some((b) => b.t.id === t.id));
    // "Escultor de Poder": in its area moves, 1 + MOVE allies are left out
    if (opts.area && rules.hasFeat(attacker, "Escultor de Poder")) {
      let spare = 1 + Math.max(0, rules.movePower(attacker, raw, false) ?? 0);
      const kept = [];
      for (const t of targetItems) {
        if (spare > 0 && t.id !== attackerItem.id && getSheet(t) && allies(aSheet, getSheet(t))) { spare--; entry.notes.push(`${t.name} poupado (Escultor de Poder)`); }
        else kept.push(t);
      }
      targetItems = kept;
    }
  }

  let jumped = 0;
  if (!activating && settings.checkRange && !opts.ignoreRange && !opts.area && targetItems.length) {
    // Fly/Dig...: the reach is counted from where the move was activated
    const from = releasing && charging.invuln && charging.from ? { ...attackerItem, position: charging.from, metadata: {} } : attackerItem;
    const jump = move.rangeInfo.kind === "melee" ? await jumpOpts(rules, attackerItem) : null;
    const res = await checkRange(from, move, targetItems, { jump });
    const out = res.filter((x) => !x.ok);
    if (out.length) throw new OutOfRange(out);
    jumped = Math.max(0, ...res.map((x) => x.jump ?? 0));
  }
  if (activating && sp.kind === "invuln" && tracked && sp.cost) {
    const mv = movement(rules, attackerItem);
    if (mv.left + 0.05 < sp.cost) throw new TurnError(`${move.label}: precisa de ${fmtM(sp.cost)} de deslocamento e sobra ${fmtM(mv.left)} (o Move falha).`);
  }
  // 1) whose turn is it, and which action does this spend
  let cost;
  if (releasing && charging.focus) {
    // Focus Punch: the blow is a free action at the start of its next turn
    if (running && !opts.force && !isActive(attackerItem)) throw new TurnError("Focus Punch só sai no turno deste Pokémon.");
    cost = null;
    entry.cost = "ação livre";
  } else if (opts.defense && tracked && !opts.force) {
    // a defensive reaction that is a move (Upper Hand): the reaction and the next action
    if (!econOf(aSheet).reaction) throw new TurnError("A reação já foi usada.");
    cost = { spend: ["reaction"], label: "reação (defesa), perde a ação do próximo turno", reaction: true, losesNextAction: true };
    entry.cost = cost.label;
  } else if (opts.opportunity && tracked && !opts.force) {
    // ataque de oportunidade (pág. 54): the reaction, with a melee "1 ação" move; it doesn't take the next action
    if (!econOf(aSheet).reaction) throw new TurnError("A reação já foi usada.");
    if (conditionsOf(aSheet).Confused) throw new TurnError("Confuso: não pode usar reações.");
    cost = { spend: ["reaction"], label: "reação (ataque de oportunidade)", reaction: true };
    entry.cost = cost.label;
  } else if (melee && tracked && !opts.force && isActive(attackerItem) && rules.hasFeat(attacker, "Investida Poderosa")
      && aSheet.battle?.move?.dash && !econOf(aSheet).action && econOf(aSheet).bonus) {
    // "Investida Poderosa": after Disparada the bonus action can attack in melee
    cost = { spend: ["bonus"], label: "ação bônus (Investida Poderosa)", powerCharge: true };
    entry.cost = cost.label;
  } else {
    cost = opts.force ? null : chooseCost(attackerItem, raw, running);
    if (cost && sp?.kind === "recharge") { cost.recharge = true; cost.label += ", recarga no próximo turno"; }
    if (cost) entry.cost = cost.label;
  }

  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  entry.roller = roller.name;
  const moveName_ = move.label.replace(/ PMP$/, "");

  // conditions that can stop the attacker (paralysis d4, confusion d6, charm d4...)
  if (fx.hpCost) { // Belly Drum fails below half HP or with Ataque already at +6
    if (attacker.hp.current < rules.maxHP(attacker) / 2) throw new Error(`${move.label} falha: precisa de pelo menos metade do HP.`);
    if (stage(attacker, "Attack") >= 6) throw new Error(`${move.label} falha: o Ataque já está no máximo.`);
  }
  const gate = await statusGate(rules, attackerItem, roller, { thawSelf: fx.thawSelf });
  if (gate.checks?.length) entry.checks = gate.checks;
  if (!gate.canAct) {
    await updateSheet(attackerItem.id, (s) => {
      if (gate.paraLock) { s.battle.paraLock = true; s.battle.econ = { action: false, bonus: false, reaction: false }; }
      else if (gate.spendsAction) spend(s, cost);
      if (gate.selfDamage) takeDamage(s.pkmn, gate.selfDamage);
    });
    entry.results.push({ target: null, note: gate.reason });
    entry.failed = true;
    await pushLog(entry);
    return entry;
  }

  // two-turn moves, first part: PP and the action now, the attack on its next turn
  if (activating) {
    const usesMove = sp.kind === "invuln" && tracked && sp.cost;
    await updateSheet(attackerItem.id, (s) => {
      if (settings.autoPP && typeof move.pp === "number") s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - 1);
      spend(s, cost);
      s.battle.charging = {
        // battle.turns goes up at the end of each of its turns: used on its turn, it's ready on the
        // next one; used out of its turn, on the coming one
        move: moveName, readyAt: (s.battle.turns ?? 0) + (isActive(attackerItem) ? 1 : 0), invuln: sp.kind === "invuln", kind: sp.semi ?? null,
        focus: sp.kind === "focus", from: { ...attackerItem.position },
      };
      if (usesMove) { s.battle.move ??= { used: 0 }; s.battle.move.used = Math.round(((s.battle.move.used ?? 0) + sp.cost) * 10) / 10; }
      for (const st of fx.self) addStage(s.pkmn, st.stat, st.delta); // Skull Bash, Meteor Beam...
      delete s.battle.prepared;
    });
    const note = sp.kind === "invuln"
      ? `🌀 ${who} ficou invulnerável${usesMove ? ` (gastou ${fmtM(sp.cost)} de deslocamento)` : ""}. No próximo turno: ataque com vantagem a até ${move.rangeInfo.label.replace("corpo a corpo, ", "")} daqui.`
      : sp.kind === "focus"
        ? `👊 ${who} está focando. No início do próximo turno, o golpe sai como ação livre (se não perder a concentração).`
        : `⚡ ${who} está carregando ${move.label}. Libere no próximo turno com uma ação (se não perder a concentração).`;
    entry.results.push({ target: null, note });
    if (fx.self.length) entry.notes.push(`${who}: ${stageText(fx.self)}`);
    if (settings.autoPP && typeof move.pp === "number") entry.pp = `${move.pp - 1}/${move.ppMax}`;
    await pushLog(entry);
    return entry;
  }

  // Helping Hand used as a move: the bonus waits on the ally for its NEXT attack only
  if (moveName === "Helping Hand") {
    const allyTargets = targetItems.filter((t) => getSheet(t) && t.id !== attackerItem.id && allies(aSheet, getSheet(t)));
    if (!allyTargets.length) throw new Error("Helping Hand: escolha um aliado (Pokémon da mesma equipe) como alvo.");
    await updateSheet(attackerItem.id, (s) => {
      if (settings.autoPP && typeof move.pp === "number") s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - 1);
      spend(s, cost);
    });
    const round = Number((await OBR.scene.getMetadata())["com.pretty-initiative/roundCount"] ?? 0);
    // the help die is rolled now (d6, d8 at level 5, d10 at 10, d12 at 17) and waits on the ally
    const sides = helpDie(rules, attacker);
    const rolled = await roller.batch(allyTargets.map(() => ({ amount: 1, sides, bonus: 0 })), `${who} Helping Hand`);
    allyTargets.forEach((t, i) => { t._die = rolled[i].dice[0]; });
    for (const t of allyTargets) {
      await updateSheet(t.id, (s) => { s.battle.helped = { by: who, round, die: t._die, sides }; });
      entry.results.push({ targetId: t.id, target: t.name, help: { die: t._die, sides }, effects: [`🤝 +${t._die} (d${sides}) no próximo ataque ou TR, e mais dados de dano`] });
    }
    await pushLog(entry);
    return entry;
  }

  // Protect, Wide Guard, Quick Guard, Crafty Shield, Upper Hand (protect.js): protections already up
  // block right away; who can still react is asked (5 s). A blocked target gets no rolls at all.
  if (!opts.defense && running && targetItems.length) {
    const guard = await defenses(rules, { attackerItem, move, raw, targets: targetItems, area: !!opts.area });
    entry.notes.push(...guard.notes);
    for (const b of guard.blocked) entry.results.push({ target: null, note: b.note });
    targetItems = targetItems.filter((t) => !guard.blocked.some((b) => b.id === t.id));
    if (guard.canceled || !targetItems.length) {
      // the move was still used: PP and the action are gone
      await updateSheet(attackerItem.id, (s) => {
        if (settings.autoPP && typeof move.pp === "number" && s.pkmn.moves[moveName] && !releasing) s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - 1);
        spend(s, cost);
        delete s.battle.prepared;
        if (s.battle.charging && releasing) delete s.battle.charging;
      });
      if (guard.canceled) entry.results.push({ target: null, note: guard.canceled });
      entry.failed = true;
      await pushLog(entry);
      return entry;
    }
  }

  // Helping Hand on this attack: chosen helpers (their reaction) and/or one waiting on the attacker.
  // To hit: ONE help die (an ally only has one at a time; the biggest). Damage: each helper adds half
  // the move's original dice (rounded down); a single die is rolled twice keeping the higher.
  const helpers = opts.helpers ?? [];
  const pendingHelp = (move.attackBonus != null || move.damage) ? aSheet.battle?.helped : null;
  const helped = helpers.length > 0 || !!pendingHelp;
  const helpCount = helpers.length + (pendingHelp ? 1 : 0);
  const helpSides = Math.max(0, ...helpers.map((hh) => helpDie(rules, getSheet(hh).pkmn)));
  if (helped) entry.notes.push(`Helping Hand de ${[...helpers.map((hh) => hh.name), ...(pendingHelp ? [pendingHelp.by] : [])].join(", ")}`);

  // modifiers from the attacker's stages
  const acc = stage(attacker, "Accuracy");
  const critMargin = 3 * stage(attacker, "CritMargin");
  const critAt = Math.max(2, 20 - critMargin);
  const atkStageKey = melee ? "Attack" : "SpecialAttack";
  const burned = !!conditionsOf(aSheet).Burning;
  let dc = move.saveDC != null ? move.saveDC + acc : null;

  // 2) every die of the move in ONE throw
  const dmg = move.damage;
  const hasDice = dmg && dmg.amount && dmg.dice;
  // Pontos de Amplificação/Redução (the app's "Mudanças de Status" screen + Helping Hand)
  const aProfHalf = Math.max(1, Math.floor(rules.proficiency(attacker) / 2));
  // the attacker's points (damage it deals) + the target's (damage it receives) are added together (pág. 57)
  const amp = ampPoints(attacker);
  const red = redPoints(attacker);
  const helpExtra = helped && hasDice && dmg.amount > 1 ? helpCount * Math.floor(dmg.amount / 2) : 0;
  // Stored Power / Power Trip: +1 die per positive stage of the user
  const ownBoost = fx.dicePerOwnBoost && hasDice ? Object.values(Array.isArray(attacker.stages) ? {} : attacker.stages ?? {}).reduce((a, v) => a + Math.max(0, v), 0) : 0;
  if (ownBoost) entry.notes.push(`+${ownBoost}d${dmg.dice} pelos estágios positivos`);
  const helpOneDie = helped && hasDice && dmg.amount === 1;
  // "Atacante Bestial": once per turn, melee damage dice rolled twice keeping the higher
  const beast = melee && hasDice && rules.hasFeat(attacker, "Atacante Bestial") && !(tracked && aSheet.battle?.move?.beast);
  if (beast) entry.notes.push("Atacante Bestial: dano rolado 2x, fica o maior");
  // { amount, flat, reroll (1 keep higher / -1 keep lower), halvings } for these points
  const dmgSpec = (a, rd) => {
    const pts = pointsSummary(a, rd);
    const amped = hasDice ? amplifyDice(dmg.amount, dmg.dice, pts.ampGroups) : { amount: 0, bonus: 0 };
    const keepHigh = pts.ampReroll || helpOneDie || beast;
    return {
      a, rd,
      amount: amped.amount + helpExtra + ownBoost,
      flat: amped.bonus + (pts.ampFlat ? aProfHalf : 0) - (pts.redFlat ? aProfHalf : 0),
      reroll: keepHigh && !pts.redReroll ? 1 : pts.redReroll && !keepHigh ? -1 : 0,
      halvings: pts.redHalvings,
    };
  };
  const baseSpec = dmgSpec(amp, red);
  const dmgAmount = baseSpec.amount;
  if (amp || red) entry.notes.push(`pontos de dano: ${pointsText(amp, red, dmg?.amount || 1, dmg?.dice || 8) || "—"}`);
  if (helpExtra) entry.notes.push(`Helping Hand: +${helpExtra}d${dmg.dice} de dano`);
  else if (helpOneDie) entry.notes.push("Helping Hand: dano rolado 2x, fica o maior");
  const parts = [];
  const want = (p) => parts.push(p) - 1;
  const dmgParts = (sp = baseSpec) => Array.from({ length: dmg.times }, () => [want({ amount: sp.amount, sides: dmg.dice, bonus: dmg.bonus }), sp.reroll ? want({ amount: sp.amount, sides: dmg.dice, bonus: 0 }) : null]);

  // targets the move can't touch
  for (const b of blocked) entry.results.push({ target: null, note: `${b.t.name}: ${b.reason}, não foi atingido`, effects: [] });
  if (move.type === "Ground" && moveName !== "Thousand Arrows") {
    // "Pokémon elevados não são afetados por Moves do tipo Terra" (pág. 52)
    const up = targetItems.filter(elevated);
    for (const t of up) entry.results.push({ target: null, note: `${t.name}: elevado (voando a ${fmtM(getSheet(t).battle.alt)}), imune a Moves de Terra`, effects: [] });
    targetItems = targetItems.filter((t) => !elevated(t));
  }
  // a flier's ranged moves: disadvantage (or advantage on the save) beyond half the range (pág. 52)
  const farFromFlier = new Set();
  if (elevated(attackerItem) && !melee && move.rangeInfo.meters) {
    for (const t of targetItems) if ((await distanceMeters(attackerItem, t)) > move.rangeInfo.meters / 2 + 0.05) farFromFlier.add(t.id);
    if (farFromFlier.size) entry.notes.push("voando: desvantagem além da metade do alcance");
  }
  // Fly/Bounce/Dig...: the attack comes with advantage, with the text's penalty ("corpo a corpo -1")
  const diving = releasing && charging.invuln;
  const releasePenalty = diving ? -(Number(/ataque corpo a corpo\s*-\s*(\d)/i.exec(raw.Description ?? "")?.[1]) || 0) : 0;
  if (diving) entry.notes.push(`saiu de ${charging.move} com vantagem${releasePenalty ? ` (${releasePenalty} no acerto)` : ""}`);
  if (jumped) entry.notes.push(`pulou ${fmtM(jumped)} pra alcançar`);
  // "Ataques à Distância Engajados" (pág. 53): a hostile creature within 1,5 m that isn't incapacitated
  let engaged = false;
  if (!melee && move.attackBonus != null && !opts.area) {
    const near = await OBR.scene.items.getItems((i) => i.id !== attackerItem.id && getSheet(i) && !allies(aSheet, getSheet(i)));
    for (const o of near) {
      const os = getSheet(o);
      if (os.pkmn.hp.current <= 0 || ["Asleep", "Frozen", "Stunned"].some((k) => conditionsOf(os)[k]) || invulnOf(os)) continue;
      if ((await distanceMeters(attackerItem, o)) <= 1.55) { engaged = true; entry.notes.push(`engajado por ${o.name}: desvantagem no ataque à distância`); break; }
    }
  }
  if (opts.opportunity) entry.notes.push(opts.sentinel ? "reação do Sentinela" : "ataque de oportunidade");
  // "Mestre de Combate Corpo a Corpo / à Distância": −5 no acerto (ou na CD) para +10 de dano
  const power = opts.power && (melee ? rules.hasFeat(attacker, "Mestre de Combate Corpo a Corpo") : rules.hasFeat(attacker, "Mestre de Combate à Distância"));
  if (power) entry.notes.push("−5 / +10 (Mestre de Combate)");
  if (power && move.attackBonus == null && dc != null) dc -= 5; // a save move: −5 on the DC instead
  // "Investida Poderosa": after Disparada, a melee attack as a bonus action, +5 damage after 3 m
  const chargeBonus = cost?.powerCharge && (aSheet.battle?.move?.used ?? 0) >= 3 ? 5 : 0;
  if (cost?.powerCharge) entry.notes.push(`Investida Poderosa${chargeBonus ? " (+5 de dano)" : ""}`);

  // several strikes (Double Kick, Dual Wingbeat, Triple Dive...): one attack roll each; with more
  // than one target chosen, the strikes go round them in order
  const nHits = move.hits > 1 && !opts.area && targetItems.length ? move.hits : 1;
  if (nHits > 1 && targetItems.length > nHits) throw new Error(`${move.label}: são ${nHits} golpes, escolha até ${nHits} alvos.`);
  const seq = nHits > 1 ? Array.from({ length: nHits }, (_, i) => ({ t: targetItems[i % targetItems.length], strike: i })) : targetItems.map((t) => ({ t, strike: 0 }));
  if (nHits > 1) entry.notes.push(`${nHits} golpes${move.firstOnlyBonus ? " (bônus de MOVE só no 1º)" : ""}`);
  // sure-hit moves (Swift, Aerial Ace): a d20 per target only for the critical
  if (move.sureHit && targetItems.length) entry.notes.push("acerto garantido (o d20 só decide o crítico)");

  const plans = seq.map(({ t, strike }) => {
    const tSheet = getSheet(t);
    const target = tSheet?.pkmn;
    const far = farFromFlier.has(t.id);
    const saveAdv = Math.max(-1, Math.min(1, (tSheet && move.save ? saveAdvantage(tSheet, move.save) : 0) + (far ? 1 : 0)));
    const saveMod = move.saveDC != null && target ? (rules.saves(target)[move.save] ?? 0) + stage(target, "Evasion") : null;
    const adv = move.attackBonus != null && tSheet ? Math.max(-1, Math.min(1,
      attackAdvantage(aSheet, tSheet, attackerItem.id) + (diving ? 1 : 0) - (far ? 1 : 0) - (engaged ? 1 : 0)
      + (opts.opportunity && rules.hasFeat(attacker, "Mestre de Combate Corpo a Corpo") ? 1 : 0))) : 0;
    const inv = invulnCheck(tSheet, moveName);
    const contestMod = fx.contest && target ? mod(rules.attributes(target)[fx.contest.attr] ?? 10) : null;
    // damage this target receives: its own "dano recebido" points join the attacker's
    const inA = tSheet?.battle?.ampIn ?? 0, inR = tSheet?.battle?.redIn ?? 0;
    const spec0 = inA || inR ? dmgSpec(amp + inA, red + inR) : baseSpec;
    // Triple Axel: the 2nd strike rolls twice the dice, the 3rd three times; the MOVE bonus only on the 1st
    const spec = nHits > 1 ? { ...spec0, amount: spec0.amount * (move.scaleDice ? strike + 1 : 1), cut: move.firstOnlyBonus && strike > 0 ? (dmg?.moveMod ?? 0) : 0 } : spec0;
    return {
      t, tSheet, target, saveMod, adv, saveAdv, inv, spec, strike,
      dmg2: inv?.double && hasDice ? Array.from({ length: dmg.times }, () => want({ amount: spec.amount, sides: dmg.dice, bonus: 0 })) : null,
      // Punishment: +1 die per positive stage of the target (max 7)
      boost: fx.dicePerTargetBoost && hasDice && target ? (() => {
        const k = Math.min(fx.dicePerTargetBoost, Object.values(Array.isArray(target.stages) ? {} : target.stages ?? {}).reduce((a, v) => a + Math.max(0, v), 0));
        return k ? want({ amount: k, sides: dmg.dice, bonus: 0 }) : null;
      })() : null,
      // team/owner travel with the result so each viewer can hide what they shouldn't see
      r: { targetId: t.id, target: `${t.name || (target ? rules.name(target) : "Alvo")}${nHits > 1 ? ` (${strike + 1}º golpe)` : ""}`, effects: [], team: tSheet ? teamOf(tSheet) : null, owner: tSheet?.owner ?? null },
      atk: move.attackBonus != null ? want({ amount: adv ? 2 : 1, sides: 20, bonus: move.attackBonus }) : null,
      sure: move.sureHit && move.attackBonus == null ? want({ amount: 1, sides: 20, bonus: 0 }) : null,
      // the waiting die was already rolled; chips roll theirs in this throw
      help: helpSides && !pendingHelp?.die && move.attackBonus != null ? want({ amount: 1, sides: helpSides, bonus: 0 }) : null,
      helpFixed: move.attackBonus != null ? Math.max(pendingHelp?.die ?? 0, 0) : 0,
      sav: saveMod != null ? want({ amount: saveAdv ? 2 : 1, sides: 20, bonus: saveMod }) : null,
      con: fx.contest && (fx.contest.status || fx.contest.stages.length) ? want({ amount: 1, sides: 20, bonus: 0 }) : null,
      contestMod,
      // (an area rolls once for everyone with the attacker's dice; the target's points then only halve)
      dmg: hasDice && !opts.area ? dmgParts(spec) : null,
    };
  });
  const sharedDmg = hasDice && (opts.area || !targetItems.length) ? dmgParts() : null;
  const rolled = parts.length ? await roller.batch(parts, `${moveName_}${opts.area ? " (área)" : ""}`) : [];
  const dice = (i) => rolled[i].dice;
  const pick = (i, adv) => (adv > 0 ? Math.max(...dice(i)) : adv < 0 ? Math.min(...dice(i)) : dice(i)[0]);
  // one hit: the dice (or the better/worse of two rolls when there are rerolling points)
  const sumHit = ([main, second], sp) => {
    const a = dice(main).reduce((x, y) => x + y, 0);
    if (second == null) return { dice: dice(main), total: a };
    const b = dice(second).reduce((x, y) => x + y, 0);
    const useB = sp.reroll > 0 ? b > a : b < a;
    return useB ? { dice: dice(second), total: b } : { dice: dice(main), total: a };
  };
  const sumDamage = (list, sp = baseSpec) => {
    const hits = list.map((x) => sumHit(x, sp));
    return { dice: hits.map((h) => h.dice), total: hits.reduce((a, h) => a + h.total + dmg.bonus + sp.flat - (sp.cut ?? 0), 0) };
  };

  const changes = new Map(); // targetId -> { damage, give: [], stages: [], wake, thaw, smack, clearHelp }
  const change = (id) => { if (!changes.has(id)) changes.set(id, { damage: 0, give: [], stages: [] }); return changes.get(id); };

  // 3) attacks, saves and contests
  let anyHit = false;
  for (const p of plans) {
    const { r, target } = p;
    p.hitFactor = 1;
    p.crit = false;
    if (p.atk != null) {
      const n = pick(p.atk, p.adv);
      // one help die at a time: the rolled one or the one waiting (the bigger)
      const bonus = Math.max(p.help != null ? dice(p.help)[0] : 0, p.helpFixed);
      const total = n + move.attackBonus + acc + bonus + releasePenalty - (power ? 5 : 0);
      const ac = target ? rules.ac(target) + stage(target, "Evasion") : null;
      p.crit = n >= critAt;
      const hit = n !== 1 && (p.crit || ac == null || total >= ac);
      r.attack = { nat: n, total, ac, crit: p.crit, hit, fumble: n === 1, adv: p.adv > 0, help: bonus || null };
      if (!hit) p.hitFactor = 0;
    } else if (p.sure != null) {
      // acerto garantido: always hits, even on a natural 1; the d20 only for the critical
      const n = dice(p.sure)[0];
      p.crit = n >= critAt;
      r.attack = { nat: n, total: null, ac: null, crit: p.crit, hit: true, fumble: false, adv: false, help: null, sure: true };
    }
    if (dc != null && (p.atk == null || r.attack.hit)) {
      const attr = ATTR_PT[move.save] ?? move.save;
      const effectOnly = p.atk != null; // attack + save (e.g. Acid Spray): the save is for the secondary effect
      if (p.sav != null) {
        const n = pick(p.sav, p.saveAdv);
        // natural 20 always passes (and takes no damage), natural 1 always fails (and is a critical hit)
        // a Helping Hand die waiting on the target also goes into its save
        const hb = p.tSheet?.battle?.helped?.die ?? 0;
        if (hb) change(p.t.id).clearHelp = true;
        const success = n === 20 || (n !== 1 && n + p.saveMod + hb >= dc);
        r.save = { attr, nat: n, total: n + p.saveMod + hb, dc, success, effectOnly, dis: p.saveAdv < 0, help: hb || null };
        if (!effectOnly) {
          if (n === 20) p.hitFactor = 0;
          else if (success) p.hitFactor = 0.5;
          if (n === 1) p.crit = true;
        }
      } else r.save = { attr, dc, unknown: true, effectOnly };
    }
    if (p.con != null && target) {
      const n = dice(p.con)[0];
      const total = n + (rules.movePower(attacker, raw, true) ?? 0) + fx.contest.bonus + acc;
      const vs = 10 + p.contestMod;
      const auto = fx.contest.autoType && rules.types(attacker).some((t) => TYPE_PT[t]?.toLowerCase() === fx.contest.autoType.toLowerCase() || t.toLowerCase() === fx.contest.autoType.toLowerCase());
      r.contest = { nat: n, total, vs, success: auto || total >= vs, auto };
    }
    if (p.hitFactor > 0 && (p.atk == null || r.attack.hit)) anyHit = true;
    entry.results.push(r);
  }

  // critical hits roll only their extra dice, in a second (small) throw
  const crits = plans.filter((p) => p.crit && p.dmg && p.hitFactor > 0);
  const critRolls = crits.length ? await roller.batch(crits.flatMap((p) => p.dmg.map(() => ({ amount: p.spec.amount, sides: dmg.dice, bonus: 0 }))), `${moveName_} CRÍTICO`) : [];

  // 4) damage: stages, burn, type, defense
  if (dmg) {
    let c = 0;
    const aProf = rules.proficiency(attacker);
    for (const p of plans) {
      if (p.hitFactor === 0) continue;
      let roll = !hasDice ? { dice: [], total: (dmg.bonus - (p.spec.cut ?? 0)) * dmg.times } : (p.dmg ? sumDamage(p.dmg, p.spec) : sumDamage(sharedDmg));
      if (p.boost != null) {
        const extra = dice(p.boost);
        roll = { dice: roll.dice.map((d0, i) => (i === 0 ? [...d0, ...extra] : d0)), total: roll.total + extra.reduce((a, b) => a + b, 0) };
        p.r.effects.push(`+${extra.length} dado(s) pelos estágios positivos do alvo`);
      }
      if (p.dmg2) {
        // Gust/Twister on Fly, Earthquake on Dig: double damage dice
        const extra = p.dmg2.map((i) => dice(i));
        roll = { dice: roll.dice.map((d0, i) => [...d0, ...(extra[i] ?? [])]), total: roll.total + extra.flat().reduce((a, b) => a + b, 0) };
        p.r.effects.push(`dados de dano dobrados (${p.inv.move})`);
      }
      if (p.crit && p.dmg) {
        const extra = p.dmg.map(() => critRolls[c++].dice);
        roll = { dice: roll.dice.map((d0, i) => [...d0, ...extra[i]]), total: roll.total + extra.flat().reduce((a, b) => a + b, 0) };
      }
      // Ataque/Ataque Especial: + stage x proficiency (a crit ignores the attacker's negative stages)
      let atkStage = stage(attacker, atkStageKey);
      if (p.crit && atkStage < 0) atkStage = 0;
      // Mestre de Combate: +10 once (on a save move, only when the target failed); Investida Poderosa +5
      const featDmg = (power && (move.attackBonus != null || p.hitFactor === 1) ? 10 : 0) + chargeBonus;
      let total = roll.total + atkStage * aProf + featDmg;
      if (burned && melee) total = Math.floor(total / 2); // Queimado: melee damage halved
      // "Ordem da entrada de dano" (pág. 55): ... 8. Defesa/Defesa Especial do alvo,
      // 9. vulnerabilidades e resistências por último
      const eff = p.target ? rules.effectiveness(move.type, p.target) : 1;
      let final = Math.max(0, total);
      if (p.target) {
        let defStage = stage(p.target, melee ? "Defense" : "SpecialDefense");
        if (p.crit && defStage > 0) defStage = 0; // a crit ignores the defender's positive stages
        final = Math.max(0, final - defStage * rules.proficiency(p.target));
      }
      final = Math.floor(final * eff);
      if (p.hitFactor === 0.5) final = Math.floor(final / 2);
      // Redução: each 2 points halve the final damage (rounded down each time)
      // Redução: each 2 points halve the final damage (the target's "dano recebido" points count here too)
      const halvings = p.dmg ? p.spec.halvings : pointsSummary(0, red + (p.tSheet?.battle?.redIn ?? 0)).redHalvings;
      for (let i = 0; i < halvings; i++) final = Math.floor(final / 2);
      p.r.damage = { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus + (p.dmg ? p.spec : baseSpec).flat - (p.spec.cut ?? 0) + atkStage * aProf + featDmg, rolled: total, eff, effLabel: effLabel(eff), final, half: p.hitFactor === 0.5, shared: !!opts.area, crit: p.crit };
      if (p.target && settings.autoDamage && final > 0) {
        const ch = change(p.t.id);
        ch.damage += final;
        if (p.crit) ch.wake = true; // a critical hit wakes up / removes Sonolento
        if (move.type === "Fire") ch.thaw = true; // fire damage thaws
      }
    }
  }

  // 5) effects from the move text
  const naturalSelf = [];
  for (const p of plans) {
    if (!p.target) continue;
    // immune to the type of a damaging move: no damage and no secondary effects (pág. 55)
    if (dmg && rules.effectiveness(move.type, p.target) === 0) continue;
    const ch = change(p.t.id);
    const hit = p.atk == null || p.r.attack.hit;
    const failed = p.r.save && !p.r.save.unknown && !p.r.save.success;
    // natural result on the attack roll ("mesmo que o golpe erre": Charge Beam)
    if (fx.natural && p.r.attack && (p.r.attack.hit || fx.natural.evenMiss) && p.r.attack.nat >= fx.natural.min) {
      if (fx.natural.self) naturalSelf.push(...fx.natural.stages); // Metal Claw, Ancient Power: the user's
      else ch.stages.push(...fx.natural.stages);
      if (fx.natural.table && p.r.attack.hit) {
        // Dire Claw / Tri Attack: d6 on the table
        const face = d(6);
        ch.give.push(fx.natural.table[face - 1]);
        p.r.effects.push(`d6 = ${face}`);
      } else if (fx.natural.status && p.r.attack.hit) ch.give.push(fx.natural.status);
    }
    if (fx.syrup && hit && p.hitFactor > 0) ch.syrup = fx.syrup; // Syrup Bomb: −1 Velocidade a cada turno
    // Sentinela: an attack of opportunity that hits stops the creature for the rest of the turn
    if (opts.opportunity && hit && p.hitFactor > 0 && rules.hasFeat(attacker, "Sentinela")) ch.stop = true;
    if (fx.cureBurn && hit) ch.cureBurn = true; // Sparkling Aria
    if (failed) { if (fx.statusFail) ch.give.push(fx.statusFail); ch.stages.push(...fx.fail); }
    if (hit && fx.direct.length && (dmg ? p.hitFactor > 0 : !move.save)) ch.stages.push(...fx.direct);
    if (p.r.contest?.success) { if (fx.contest.status) ch.give.push(fx.contest.status); ch.stages.push(...fx.contest.stages); }
    if (fx.statusDirect && hit && !move.save) ch.give.push(fx.statusDirect);
    if (fx.statusHit && p.r.attack?.hit) ch.give.push(fx.statusHit); // Fake Out: atordoado no acerto
    // Smack Down: an elevated Pokémon (or one in Fly/Bounce) is brought down
    if (moveName === "Smack Down" && hit && p.hitFactor > 0 && (getSheet(p.t)?.battle?.alt > 0 || p.inv?.cancel)) ch.smack = true;
  }
  // a charged move's self stages came when it was activated
  let selfStages = !releasing && fx.self.length && (move.attackBonus == null || anyHit || !targetItems.length) ? [...fx.self] : [];
  selfStages.push(...naturalSelf);
  // Psych Up: the user's stages become a copy of the target's
  const copyFrom = fx.copyStages && plans[0]?.target ? { ...(Array.isArray(plans[0].target.stages) ? {} : plans[0].target.stages ?? {}) } : null;
  if (copyFrom) { delete copyFrom.CritMargin; entry.notes.push(`${who} copiou os estágios de ${plans[0].r.target}`); }

  if (!targetItems.length) {
    if (dmg) {
      const roll = hasDice ? sumDamage(sharedDmg) : { dice: [], total: dmg.bonus };
      entry.results.push({ target: null, note: `Dano: ${Math.max(0, roll.total)} (${move.damageText})`, damage: { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus, final: Math.max(0, roll.total) } });
    } else if (!selfStages.length) entry.results.push({ target: null, note: opts.area ? "Nenhum alvo na área" : "Move usado" });
  }

  // 6) write everything
  // (a charged / invulnerable move already used its PP when it was activated)
  const usesPP = !releasing && settings.autoPP && typeof move.pp === "number" && !!attacker.moves?.[moveName];
  await updateSheet(attackerItem.id, (s) => {
    if (usesPP) s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - 1);
    spend(s, cost);
    if (copyFrom) s.pkmn.stages = { ...copyFrom, ...(s.pkmn.stages?.CritMargin ? { CritMargin: s.pkmn.stages.CritMargin } : {}) };
    for (const st of selfStages) addStage(s.pkmn, st.stat, st.delta);
    if (fx.hpCost) { // Belly Drum: half of its max HP
      const cost = Math.floor(rules.maxHP(s.pkmn) * fx.hpCost);
      s.pkmn.hp.current = Math.max(0, s.pkmn.hp.current - cost);
      entry.notes.push(`${who} perdeu ${cost} HP`);
    }
    if (fx.rest) { // Rest: full HP, conditions cured, sleeps
      s.pkmn.hp.current = rules.maxHP(s.pkmn);
      s.battle.cond = {};
      giveCondition(s, "Asleep", rules, {});
      entry.notes.push(`${who} recuperou todo o HP e dormiu`);
    }
    if (fx.refresh) { // Refresh: Queimado, Envenenado, Paralisado
      for (const k of ["Burning", "Poisoned", "BadlyPoisoned", "Paralyzed"]) if (clearCondition(s, k)) entry.notes.push(`${who} curou ${CONDITIONS[k].label}`);
    }
    if (fx.thawSelf && clearCondition(s, "Frozen")) entry.notes.push(`${who} descongelou`);
    if (pendingHelp) delete s.battle.helped; // Helping Hand is for ONE move
    if (s.battle.charging) {
      if (!releasing) entry.notes.push(`a carga de ${s.battle.charging.move} se perdeu`);
      delete s.battle.charging; // released, or lost by using another move
    }
    delete s.battle.prepared;
    if (opts.opportunity) delete s.battle.oa;
    if (jumped && tracked) { s.battle.move ??= { used: 0 }; s.battle.move.used = Math.round(((s.battle.move.used ?? 0) + jumped) * 10) / 10; }
    if (tracked) {
      s.battle.move ??= { used: 0 };
      if (beast) s.battle.move.beast = true; // Atacante Bestial: once per turn
      // Mobilidade: no attacks of opportunity from the creatures it attacked in melee this turn
      if (melee) s.battle.move.meleed = [...new Set([...(s.battle.move.meleed ?? []), ...targetItems.map((t) => t.id)])];
    }
  });
  if (usesPP) entry.pp = `${move.pp - 1}/${move.ppMax}`;
  if (selfStages.length) entry.notes.push(`${who}: ${stageText(selfStages)}`);
  // Fly/Dig/Dive...: it comes back next to the target
  if (diving && targetItems[0]) {
    const spot = await approach(rules, { ...attackerItem, metadata: {} }, targetItems[0], { rangeInfo: { kind: "melee", meters: 1.5, label: "corpo a corpo" } }).catch(() => null);
    if (spot) await moveToken(attackerItem.id, spot.pos, 0);
  }
  for (const h of helpers) {
    await updateSheet(h.id, (s) => {
      // Helping Hand: "abre mão de sua ação no próximo turno"
      s.battle.econ = { action: true, bonus: true, ...(s.battle.econ ?? {}), reaction: false, ...(running && inInitiative(h) ? { loseAction: true } : {}) };
      if (settings.autoPP && typeof rules.movePP(s.pkmn, "Helping Hand") === "number") s.pkmn.moves["Helping Hand"].pp = Math.max(0, rules.movePP(s.pkmn, "Helping Hand") - 1);
    });
  }
  // Endure: a hit that would knock someone out (its owner is asked, 5 s)
  if (!opts.defense && running && [...changes.values()].some((c) => c.damage > 0)) {
    await endure(rules, { attackerItem, move, targets: targetItems, changes, results: entry.results });
  }
  for (const [id, ch] of changes) {
    if (!ch.damage && !ch.give.length && !ch.stages.length && !ch.smack && !ch.clearHelp && !ch.syrup && !ch.cureBurn && !ch.stop) continue;
    const r = entry.results.find((x) => x.targetId === id);
    const ownTurn = isActive(targetItems.find((t) => t.id === id));
    await updateSheet(id, (s, dr) => {
      // Sentinela: the hit pulls the creature back to where it left the reach, and it stops there
      if (ch.stop && opts.oaBack && dr) {
        dr.position = { ...opts.oaBack };
        s.battle.move = { used: 0, ...(s.battle.move ?? {}), pos: { ...opts.oaBack } };
        r.effects.push("puxado de volta pro alcance (Sentinela)");
      }
      if (ch.damage) takeDamage(s.pkmn, ch.damage);
      if (ch.clearHelp) delete s.battle.helped; // its Helping Hand die went into this save
      if (ch.syrup) { s.battle.syrup = ch.syrup; r.effects.push(`coberto de xarope (−1 Velocidade por turno, ${ch.syrup} turnos)`); }
      if (ch.cureBurn && clearCondition(s, "Burning")) r.effects.push("queimadura curada");
      if (ch.stop) { s.battle.move = { used: 0, ...(s.battle.move ?? {}), stopped: true }; r.effects.push("parado (Sentinela)"); }
      // charging / Focus Punch: concentration (CON save, DC 10 or half the damage)
      const c = s.battle.charging;
      if (c && !c.invuln && ch.damage > 0 && s.pkmn.hp.current > 0) {
        const dc = Math.max(10, Math.floor(ch.damage / 2));
        const n = d(20), total = n + (rules.saves(s.pkmn).CON ?? 0);
        if (n !== 20 && (n === 1 || total < dc)) { delete s.battle.charging; r.effects.push(`perdeu a concentração em ${c.move} (CON ${total} vs CD ${dc})`); }
        else r.effects.push(`manteve a concentração (CON ${total} vs CD ${dc})`);
      }
      if (ch.smack) {
        if (s.battle.charging?.invuln) { r.effects.push(`${s.battle.charging.move} cancelado`); delete s.battle.charging; }
        s.battle.grounded = true;
        s.battle.prone = true;
        r.effects.push("derrubado ao chão");
      }
      if (ch.wake) { if (clearCondition(s, "Asleep")) r.effects.push("acordou com o crítico"); if (clearCondition(s, "Drowsy")) r.effects.push("não está mais sonolento"); }
      if (ch.thaw && clearCondition(s, "Frozen")) r.effects.push("descongelou com o fogo");
      for (const key of [...new Set(ch.give)]) {
        if (s.pkmn.hp.current <= 0) break;
        const res = giveCondition(s, key, rules, { ownTurn });
        r.effects.push(res.ok ? `ficou ${CONDITIONS[res.became ?? key].label}` : `${CONDITIONS[key].label}: ${res.reason}`);
      }
      for (const st of ch.stages) addStage(s.pkmn, st.stat, st.delta);
      if (ch.stages.length) r.effects.push(stageText(ch.stages));
    });
    const after = getSheet((await OBR.scene.items.getItems([id]))[0]);
    if (after && r) {
      r.hpAfter = `${after.pkmn.hp.current}/${rules.maxHP(after.pkmn)}`;
      if (after.pkmn.hp.current <= 0) r.effects.push("DESMAIOU");
    }
  }

  // switching and trapping moves (trainer.js): Dragon Tail, Roar, U-turn, Mean Look...
  await switchEffects(rules, { attackerItem, moveName, targetItems, entry });
  await pushLog(entry);
  if (settings.mapFx) await sendFx(attackerItem, entry, targetItems).catch(() => {});
  // Sentinela nearby: attacking someone else gives them a reaction attack
  if (running && !opts.opportunity && (move.attackBonus != null || move.saveDC != null) && targetItems.length) await checkSentinel(rules, attackerItem, targetItems).catch(() => {});
  return entry;
}

// ------------------------------------------------------------------ "Arremessar" (pág. 54)
// Standard action: throw an object (or a willing creature) as far as a long jump, without the run
// (2 m + 1 m per STR mod point). Attack d20 + STR mod vs AC, 1d6 + STR mod typeless damage.
// Ghosts are immune. Works on flying targets (the distance counts the altitude).
export const THROW = "__throw";
export const throwRange = (rules, pkmn) => 2 + Math.max(0, mod(rules.attributes(pkmn).STR));

// Throwing a creature (opts.creature) at a target (pág. 53):
//   - an ally or an unconscious creature: no test, full distance;
//   - an enemy: it must be grappled by the thrower first, and goes half the distance;
//   - it lands next to the target, at the target's height: thrown up to a flier, it stays in the air
//     until the end of its next turn (and can hit it in melee), then falls (Queda);
//   - hitting an enemy target: 1d6 + FOR, +1d6 per size category the creature is bigger than the target;
//     Ghosts are immune unless the thrown creature is Ghost or Dark.
// Without opts.creature, it's an object (same damage).
export async function throwAttack(rules, attackerItem, target, opts = {}) {
  const settings = await getSettings();
  const aSheet = getSheet(attackerItem);
  const pkmn = aSheet.pkmn;
  const who = attackerItem.name || rules.name(pkmn);
  const thrown = opts.creature ?? null;
  const cSheet = thrown ? getSheet(thrown) : null;
  if (!target) throw new Error("Escolha o alvo do arremesso no mapa.");
  if (invulnOf(aSheet)) throw new TurnError(`${who} está ${invulnText(aSheet.battle.charging)}.`);
  const inv = invulnCheck(getSheet(target), "Arremessar");
  if (inv?.blocked) throw new Error(`${target.name} está ${inv.reason}: não pode ser alvo.`);
  const str = mod(rules.attributes(pkmn).STR);
  let range = throwRange(rules, pkmn);
  const notes = [];
  let enemyThrown = false;
  if (thrown) {
    if (thrown.id === attackerItem.id || thrown.id === target.id) throw new Error("Escolha duas criaturas diferentes: a arremessada e o alvo.");
    const willing = !cSheet || cSheet.pkmn.hp.current <= 0 || allies(aSheet, cSheet);
    if (!willing) {
      if (conditionsOf(cSheet).Grappled?.by !== attackerItem.id) throw new Error(`${thrown.name} é inimigo: agarre primeiro (🤼 Agarrar), depois arremesse na próxima ação.`);
      enemyThrown = true;
      range = Math.floor(range / 2 * 10) / 10;
      notes.push("inimigo agarrado: metade da distância");
    }
    if (settings.checkRange && !opts.ignoreRange && (await distanceMeters(attackerItem, thrown)) > rules.reach(pkmn) + 0.05) throw new Error(`${thrown.name} precisa estar ao alcance de ${who} (${fmtM(rules.reach(pkmn))}).`);
  }
  const rangeInfo = { kind: "ranged", meters: range, label: fmtM(range) };
  if (settings.checkRange && !opts.ignoreRange) {
    const [r] = await checkRange(attackerItem, { rangeInfo }, [target]);
    if (!r.ok) throw new OutOfRange([r]);
  }
  const running = await combatRunning();
  const cost = opts.force ? null : chooseCost(attackerItem, { "Move Time": "1 ação" }, running);
  const tSheet = getSheet(target);
  const tp = tSheet?.pkmn;
  const hostileTarget = !tSheet || !allies(aSheet, tSheet);
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  const r = { targetId: target.id, target: target.name || "Alvo", effects: [], team: tSheet ? teamOf(tSheet) : null, owner: tSheet?.owner ?? null };
  let final = 0;
  if (hostileTarget) {
    // bigger than the target: +1d6 per size category
    const bigger = thrown && cSheet && tp ? Math.max(0, rules.sizeRank(cSheet.pkmn) - rules.sizeRank(tp)) : 0;
    const adv = tSheet ? attackAdvantage(aSheet, tSheet, attackerItem.id) : 0;
    const [atk, dm] = await roller.batch([{ amount: adv ? 2 : 1, sides: 20, bonus: str }, { amount: 1 + bigger, sides: 6, bonus: str }], `${who} arremessa${thrown ? ` ${thrown.name}` : ""}`);
    const n = adv ? Math.max(...atk.dice) : atk.dice[0];
    const total = n + str;
    const ac = tp ? rules.ac(tp) + stage(tp, "Evasion") : null;
    const crit = n === 20;
    const hit = n !== 1 && (crit || ac == null || total >= ac);
    const cTypes = cSheet ? rules.types(cSheet.pkmn) : [];
    const ghost = !!tp && rules.types(tp).includes("Ghost") && !cTypes.includes("Ghost") && !cTypes.includes("Dark");
    const dice = [...dm.dice, ...(crit ? dm.dice.map(() => d(6)) : [])];
    final = hit && !ghost ? Math.max(0, dice.reduce((a, b) => a + b, 0) + str) : 0;
    r.attack = { nat: n, total, ac, crit, hit, fumble: n === 1, adv: adv > 0 };
    r.damage = hit ? { dice: [dice], sides: 6, bonus: str, rolled: final, eff: ghost ? 0 : 1, effLabel: ghost ? "imune (Fantasma)" : "", final, crit } : null;
    if (bigger) notes.push(`+${bigger}d6 (${thrown.name} é maior)`);
  } else r.effects.push("aliado: só leva a criatura até ele");
  await updateSheet(attackerItem.id, (s) => { spend(s, cost); delete s.battle.prepared; });
  if (tp && final > 0 && settings.autoDamage) {
    await updateSheet(target.id, (s) => takeDamage(s.pkmn, final));
    const after = getSheet((await OBR.scene.items.getItems([target.id]))[0]);
    r.hpAfter = `${after.pkmn.hp.current}/${rules.maxHP(after.pkmn)}`;
    if (after.pkmn.hp.current <= 0) r.effects.push("DESMAIOU");
  }
  // the creature lands next to the target, at its height
  if (thrown && cSheet) {
    const height = Math.max(0, Number(tSheet?.battle?.alt) || 0);
    const spot = await approach(rules, { ...thrown, metadata: {} }, target, { rangeInfo: { kind: "melee", meters: 1.5, label: "corpo a corpo" } }).catch(() => null);
    await updateSheet(thrown.id, (s, dr) => {
      if (spot) { dr.position = { ...spot.pos }; s.battle.move = { ...(s.battle.move ?? { used: 0 }), pos: { ...spot.pos } }; }
      if (enemyThrown && s.battle.cond?.Grappled) delete s.battle.cond.Grappled; // the grapple ends
      if (height > 0) {
        s.battle.alt = height;
        // "manter um aliado no ar por um turno": up until the end of its next turn
        s.battle.thrown = { readyAt: (s.battle.turns ?? 0) + (isActive(thrown) ? 1 : 0) };
      }
    });
    if (enemyThrown) await updateSheet(attackerItem.id, (s) => { delete s.battle.grabbing; });
    notes.push(height > 0 ? `${thrown.name} foi parar no ar a ${fmtM(height)}, junto de ${target.name} (fica lá até o fim do próximo turno dele)` : `${thrown.name} caiu junto de ${target.name}`);
  }
  const entry = { kind: "move", attacker: who, move: thrown ? `Arremessar ${thrown.name}` : "Arremessar", type: "Sem tipo", results: [r], notes: [`alcance ${fmtM(range)}`, ...notes], roller: roller.name, cost: cost?.label };
  await pushLog(entry);
  if (settings.mapFx) await sendFx(attackerItem, entry, [target]).catch(() => {});
  return entry;
}

// ------------------------------------------------------------------ Agarrão (pág. 54)
// Action: FOR (Atletismo) against the target's FOR (Atletismo) or DES (Acrobacia), its best.
// The target at most one size category bigger, within reach; Ghosts only by Ghost/Dark.
const athletics = (rules, p) => rules.skillMod(p, "Athletics", "STR");
const acrobatics = (rules, p) => rules.skillMod(p, "Acrobatics", "DEX");

async function contest(roller, label, a, b) {
  const [ra, rb] = await roller.batch([{ amount: 1, sides: 20, bonus: a }, { amount: 1, sides: 20, bonus: b }], label);
  return { a: ra.dice[0] + a, b: rb.dice[0] + b, na: ra.dice[0], nb: rb.dice[0] };
}

export async function grapple(rules, attackerItem, target, opts = {}) {
  const settings = await getSettings();
  const aSheet = getSheet(attackerItem), tSheet = getSheet(target);
  if (!tSheet) throw new Error("Escolha um Pokémon com ficha pra agarrar.");
  const who = attackerItem.name;
  const ap = aSheet.pkmn, tp = tSheet.pkmn;
  if (rules.types(tp).includes("Ghost") && !rules.types(ap).some((t) => t === "Ghost" || t === "Dark")) throw new Error(`${target.name} é Fantasma: só Fantasma ou Sombrio agarra.`);
  if (rules.sizeRank(tp) > rules.sizeRank(ap) + 1) throw new Error(`${target.name} é grande demais pra ${who} agarrar.`);
  if (conditionsOf(tSheet).Grappled) throw new Error(`${target.name} já está agarrado.`);
  if (!opts.ignoreRange && (await distanceMeters(attackerItem, target)) > rules.reach(ap) + 0.05) throw new OutOfRange([{ name: target.name, reason: `fora do alcance (${fmtM(rules.reach(ap))})` }]);
  const cost = opts.force ? null : chooseCost(attackerItem, { "Move Time": "1 ação" }, await combatRunning());
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  const def = Math.max(athletics(rules, tp), acrobatics(rules, tp));
  const c = await contest(roller, `${who} agarra ${target.name}`, athletics(rules, ap), def);
  const ok = c.a > c.b;
  await updateSheet(attackerItem.id, (s) => { spend(s, cost); if (ok) s.battle.grabbing = target.id; });
  if (ok) await updateSheet(target.id, (s) => { s.battle.cond = conditionsOf(s); s.battle.cond.Grappled = { by: attackerItem.id, byName: who, since: s.battle.turns ?? 0, age: 0 }; });
  const entry = { kind: "note", attacker: who, text: `🤼 tentou agarrar ${target.name}: ${c.a} (d20 ${c.na}) contra ${c.b} (d20 ${c.nb}) — ${ok ? "AGARROU (deslocamento 0)" : "escapou"}${cost ? ` (${cost.label})` : ""}` };
  await pushLog(entry);
  return { ...entry, ok, roller: roller.name };
}

// the grappled creature's action to get free: its FOR (Atletismo) or DES (Acrobacia) against the grappler's FOR (Atletismo)
export async function escapeGrapple(rules, item, opts = {}) {
  const settings = await getSettings();
  const s0 = getSheet(item);
  const g = conditionsOf(s0).Grappled;
  if (!g) throw new Error("Não está agarrado.");
  const [holder] = await OBR.scene.items.getItems([g.by]);
  const cost = opts.force ? null : chooseCost(item, { "Move Time": "1 ação" }, await combatRunning());
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  const mine = Math.max(athletics(rules, s0.pkmn), acrobatics(rules, s0.pkmn));
  const hp = holder && getSheet(holder) ? getSheet(holder).pkmn : null;
  const c = await contest(roller, `${item.name} tenta escapar`, mine, hp ? athletics(rules, hp) : 0);
  const ok = !holder || c.a > c.b;
  await updateSheet(item.id, (s) => { spend(s, cost); if (ok) delete s.battle.cond.Grappled; });
  if (ok && holder) await updateSheet(holder.id, (s) => { delete s.battle.grabbing; });
  const entry = { kind: "note", attacker: item.name, text: `🤼 tentou escapar de ${g.byName}: ${c.a} contra ${c.b} — ${ok ? "ESCAPOU" : "continua agarrado"}` };
  await pushLog(entry);
  return entry;
}

// letting go is free on its turn
export async function releaseGrapple(item) {
  const id = getSheet(item)?.battle?.grabbing;
  if (!id) return;
  await updateSheet(item.id, (s) => { delete s.battle.grabbing; });
  await updateSheet(id, (s) => { if (s.battle.cond?.Grappled?.by === item.id) delete s.battle.cond.Grappled; });
  await pushLog({ kind: "note", attacker: item.name, text: "soltou o agarrão" });
}

// After the move: forced switches, traps and the user's own switch, from trainer.js's tables.
// The log entry is pushed after this, so the notes land in it.
async function switchEffects(rules, { attackerItem, moveName, targetItems, entry }) {
  const force = FORCE[moveName], self = SELF_SWITCH[moveName], trapRule = TRAPS[moveName];
  if (!force && !self && !trapRule) return;
  const resultOf = (t) => entry.results.find((x) => x.targetId === t.id);
  const fresh = async (id) => (await OBR.scene.items.getItems([id]))[0];
  try {
    if (force) {
      for (const t0 of targetItems) {
        const r = resultOf(t0);
        if (!happened(force.when, r)) continue;
        const t = await fresh(t0.id);
        const ts = getSheet(t);
        if (!ts || ts.pkmn.hp.current <= 0) continue;
        const ab = rules.abilities(ts.pkmn);
        if (force.wind && ab.includes("Wind Rider")) { r.effects.push("Wind Rider: não sai"); continue; }
        if (force.pick === "random") { r.effects.push(await forceRandomSwitch(rules, t, moveName)); continue; }
        // Roar / Whirlwind: the trainer chooses who comes in
        if (!ts.trainer) { r.effects.push(`selvagem: foge se o nível dele for ${moveName === "Roar" ? "igual ou " : ""}menor`); continue; }
        if (ab.includes("Guard Dog") || ab.includes("Suction Cups")) { r.effects.push("não pode ser forçado a sair"); continue; }
        if (!(await bench(ts.trainer)).length) {
          r.effects.push(moveName === "Roar" ? "sem com quem trocar: fica Amedrontado e usa a ação pra se afastar" : "sem com quem trocar: o Move falha");
          continue;
        }
        await updateSheet(t.id, (s) => { s.battle.mustSwitch = { forced: true, by: moveName }; });
        r.effects.push("tem que ser trocado (o treinador escolhe na ficha rápida)");
      }
    }
    if (trapRule) {
      const hit = targetItems.filter((t) => happened(trapRule.when, resultOf(t)));
      const who = trapRule.who === "self" ? [attackerItem]
        : trapRule.who === "both" ? (hit.length ? [attackerItem, ...hit] : [])
        : trapRule.when === "used" ? targetItems : hit;
      const names = await trap(rules, moveName, attackerItem, await Promise.all(who.map((w) => fresh(w.id))));
      if (names.length) entry.notes.push(`preso (não pode ser trocado): ${names.join(", ")}`);
    }
    if (self) {
      const any = self === "used" || targetItems.some((t) => happened(self, resultOf(t)));
      const as = getSheet(await fresh(attackerItem.id));
      if (any && as?.trainer && as.pkmn.hp.current > 0) {
        if ((await bench(as.trainer)).length) {
          await updateSheet(attackerItem.id, (s) => { s.battle.mustSwitch = { free: true, by: moveName, batonPass: moveName === "Baton Pass" }; });
          entry.notes.push(`${attackerItem.name} volta pra pokébola: escolha quem entra (ação livre)`);
        } else entry.notes.push("sem outro Pokémon pra entrar");
      }
    }
  } catch (err) {
    entry.notes.push(`troca: ${err.message}`);
  }
}

// can this viewer see the AC/HP numbers of a result's target? (players don't see the enemies')
export const seesTarget = (r, viewer) => !viewer || canSeeFull({ team: r.team ?? "jogadores", owner: r.owner }, viewer);

// one-line text of a result, for notifications and the log; viewer = { id, role } hides enemy numbers
export function describe(entry, viewer) {
  if (entry.kind === "check") return `${entry.attacker}: ${entry.label} ${entry.total} (d20 ${entry.nat}${signed(entry.bonus)})`;
  if (entry.kind === "note") return `${entry.attacker}: ${entry.text}`;
  const parts = entry.results.map((r) => {
    if (!r.target) return r.note;
    const full = seesTarget(r, viewer);
    const vsAC = (ac) => (ac != null && full ? ` vs CA ${ac}` : "");
    let s = r.target + ": ";
    if (r.attack?.sure) s += r.attack.crit ? `CRÍTICO! (acerto garantido, d20 ${r.attack.nat}) ` : `acerto garantido (d20 ${r.attack.nat}) `;
    else if (r.attack) s += r.attack.crit ? "CRÍTICO! " : r.attack.hit ? `acertou (${r.attack.total}${vsAC(r.attack.ac)}) ` : r.attack.fumble ? "errou (1 natural) " : `errou (${r.attack.total}${vsAC(r.attack.ac)}) `;
    if (r.save) s += (r.save.effectOnly ? "efeito: " : "") + (r.save.unknown ? `TR ${r.save.attr} CD ${r.save.dc} ` : `TR ${r.save.attr} ${r.save.total} vs CD ${r.save.dc} ${r.save.success ? "(passou) " : "(falhou) "}`);
    if (r.contest) s += `${r.contest.auto ? "acerto automático" : `${r.contest.total} vs ${r.contest.vs}`} ${r.contest.success ? "(pegou) " : "(resistiu) "}`;
    if (r.damage) s += `${r.damage.final} de dano${r.damage.effLabel ? ` (${r.damage.effLabel})` : ""}${r.damage.half ? " (metade)" : ""}`;
    if (r.effects?.length) s += ` — ${r.effects.join(", ")}`;
    if (r.hpAfter && full) s += ` → HP ${r.hpAfter}`;
    return s.trim();
  });
  const extra = [entry.cost ? `(${entry.cost})` : "", ...(entry.notes ?? [])].filter(Boolean).join(" · ");
  return `${entry.attacker} usou ${entry.move}${entry.area ? ` (${entry.area})` : ""}${extra ? ` ${extra}` : ""}. ${parts.join(" | ")}`;
}
