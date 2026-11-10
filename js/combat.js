// Using a move, following the PMP rulebook:
//   1. turn/action check (Pretty Sordid) and the attacker's conditions (paralysis, confusion, charm)
//   2. ONE throw with every die: attacks (with advantage/Helping Hand), saves (with disadvantage),
//      status contests and damage
//   3. stages in to-hit/DC/AC/saves/damage, crit margin, natural 1/20 on saves, burn, type effectiveness
//   4. conditions and stage changes from the move text, written to the tokens
import { OBR, getSheet, updateSheet, pushLog, getSettings } from "./store.js?v=0.9.11";
import { TYPE_PT, ATTR_PT, signed, fmtM, d } from "./rules.js?v=0.9.11";
import { checkRange, OutOfRange, sendFx, distanceMeters } from "./map.js?v=0.9.11";
import { getRoller } from "./dice.js?v=0.9.11";
import { defenses, endure } from "./protect.js?v=0.9.11";
import { FORCE, SELF_SWITCH, TRAPS, happened, trap, bench, forceRandomSwitch, dropIllusionDraft } from "./trainer.js?v=0.9.11";
import {
  CONDITIONS, STAGES, conditionsOf, giveCondition, clearCondition, stage, addStage, moveEffects, chooseCost, spend,
  statusGate, attackAdvantage, saveAdvantage, isActive, inInitiative, econOf, PRETTY, TurnError,
  allies, teamOf, canSeeFull, ampPoints, redPoints, pointsSummary, amplifyDice, pointsText,
} from "./battle.js?v=0.9.11";
import {
  special, chargingOf, invulnOf, invulnText, invulnCheck, releaseReady, elevated, movement, jumpOpts, spendMovement,
  fall, approach, moveToken, checkSentinel, jumps,
} from "./tactics.js?v=0.9.11";

import { abilitiesOf, attackMods, targetMods, afterHit, statusBlock, stageGuard, onCondition, isSound } from "./abilities.js?v=0.9.11";
import { fieldNow, startField, FIELD_MOVES, clearTerrain, clearSide, grounded, getField, roundNow } from "./field.js?v=0.9.11";
import * as MFX from "./movefx.js?v=0.9.11";

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

  // the field (weather, terrain, screens), the abilities around and this move's special rules
  const mfx = MFX.special(moveName, raw);
  // healing moves: their dice heal (movefx), they don't deal damage
  if (mfx.heal && !raw.atk && !raw.Save) move.damage = null;
  const field = await fieldNow(null, null, attackerItem);
  const round = field.round;
  const onField = await OBR.scene.items.getItems((i) => i.id !== attackerItem.id && getSheet(i) && !getSheet(i).ball && getSheet(i).pkmn.hp.current > 0);
  const gas = [aSheet, ...onField.map(getSheet)].some((s) => abilitiesOf(rules, s).includes("Neutralizing Gas"));
  const others = [];
  for (const o of onField) others.push({ item: o, sheet: getSheet(o), dist: await distanceMeters(attackerItem, o), ally: allies(aSheet, getSheet(o)) });
  const aAbil = abilitiesOf(rules, aSheet, { gas });
  const aGrounded = grounded(aSheet, aAbil);
  if (!opts.force) {
    const damp = [{ sheet: aSheet, dist: 0, item: attackerItem }, ...others].find((o) => o.dist <= 15.05 && abilitiesOf(rules, o.sheet, { gas }).includes("Damp"));
    const why = MFX.restricted(rules, aSheet, moveName, raw, { damp: damp?.item.name });
    if (why) throw new TurnError(why);
  }
  if (mfx.clearTerrain === "before" && !field.terrain && !opts.force) throw new Error(`${move.label} só funciona dentro de um terreno.`);
  if (FIELD_MOVES[moveName]?.needs && !FIELD_MOVES[moveName].needs.includes(field.weather) && !opts.force) throw new Error(`${move.label} só pode ser usado com granizo ou neve.`);
  // this use's type (Hidden Power, Weather Ball, Terrain Pulse; Normalize, Pixilate, Liquid Voice...)
  let isLast = false;
  if (aAbil.includes("Analytic") && running) {
    const order = Object.values((await OBR.scene.getMetadata())["com.pretty-initiative/order"] ?? {});
    isLast = order[order.length - 1] === attackerItem.id;
  }
  const newType = MFX.typeFor(mfx, move, { field, grounded: aGrounded });
  const aMods = attackMods(rules, aSheet, { ...move, type: newType ?? move.type }, raw,
    { field, melee, stab: move.stab > 0, isLast, others, fx, prof: rules.proficiency(attacker), gas });
  if (newType || aMods.type) {
    const nt = aMods.type ?? newType;
    // STAB follows the new type
    const stab = rules.types(attacker).includes(nt) ? rules.stabBonus(attacker) : 0;
    if (move.damage) move.damage = { ...move.damage, bonus: move.damage.bonus - (move.stab ?? 0) + stab };
    move.stab = stab;
    move.type = nt;
    entry.type = TYPE_PT[nt] ?? nt;
    if (newType) entry.notes.push(`tipo ${TYPE_PT[nt] ?? nt}`);
  }
  entry.notes.push(...aMods.notes);
  const uDice = MFX.userDice(rules, aSheet, move, mfx, { field, type: move.type, grounded: aGrounded });
  entry.notes.push(...uDice.notes);
  // two-turn moves: this use only charges / vanishes / focuses (no targets, no roll)
  // (Solar Beam / Solar Blade under strong sunlight go right away)
  const activating = !!sp && ["invuln", "focus", "charge"].includes(sp.kind) && !releasing && !(mfx.solar && field.weather === "sun");
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
    cost = opts.force ? null : chooseCost(attackerItem, raw, running, rules);
    if (cost && sp?.kind === "recharge") { cost.recharge = true; cost.label += ", recarga no próximo turno"; }
    if (cost) entry.cost = cost.label;
  }
  // Dazzling / Queenly Majesty: enemies within 15 m can't use bonus actions or reactions for Moves
  if (cost && (cost.spend.includes("bonus") || cost.spend.includes("reaction")) && !opts.force) {
    const queen = others.find((o) => !o.ally && o.dist <= 15.05 && ["Dazzling", "Queenly Majesty"].some((a) => abilitiesOf(rules, o.sheet, { gas }).includes(a)));
    if (queen) throw new TurnError(`${queen.item.name} (${abilitiesOf(rules, queen.sheet, { gas }).find((a) => ["Dazzling", "Queenly Majesty"].includes(a))}): não dá pra usar Moves com ação bônus ou reação perto dele.`);
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
  // (Unseen Fist: its melee moves go through them)
  if (aMods.unseenFist && targetItems.length) entry.notes.push("Unseen Fist: ignora proteções");
  if (!opts.defense && running && targetItems.length && !aMods.unseenFist) {
    const guard = await defenses(rules, { attackerItem, move, raw, targets: targetItems, area: !!opts.area });
    entry.notes.push(...guard.notes);
    for (const b of guard.blocked) entry.results.push({ target: null, note: b.note });
    targetItems = targetItems.filter((t) => !guard.blocked.some((b) => b.id === t.id));
    // the reactions may have changed them (Withdraw +1 Defesa, Magic Coat up, a Sucker Punch hit)
    if (targetItems.length) {
      const fresh = await OBR.scene.items.getItems(targetItems.map((t) => t.id));
      targetItems = targetItems.map((t) => fresh.find((f) => f.id === t.id) ?? t);
    }
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
  // (+ abilities: Compound Eyes, Hustle, Victory Star, Super Luck; weather: Thunder in the sun)
  const acc = stage(attacker, "Accuracy") + aMods.acc + uDice.accDelta;
  const critMargin = 3 * stage(attacker, "CritMargin");
  const critAt = Math.max(2, 20 - critMargin - aMods.crit);
  // Body Press uses the Defense stages; Foul Play the target's Attack (below)
  const atkStageKey = mfx.atkFrom ?? (melee ? "Attack" : "SpecialAttack");
  // Queimado halves melee damage (not with Guts, nor Facade)
  const burned = !!conditionsOf(aSheet).Burning && !aMods.guts && moveName !== "Facade";
  let dc = move.saveDC != null ? move.saveDC + stage(attacker, "Accuracy") + aMods.dc : null;

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
  // m: dice changes from abilities, weather/terrain and the move itself (movefx/abilities):
  //   mult/add (dice count), double, halfMore (+½ the dice; 1 die: roll twice keep higher),
  //   halve (½ the dice; 1 die: roll twice keep lower), groups (+1 die per 2), keepHigh/keepLow, flat
  const dmgSpec = (a, rd, m = {}) => {
    const pts = pointsSummary(a, rd);
    let base = hasDice ? dmg.amount * (m.mult ?? 1) + (m.add ?? 0) : 0;
    if (m.double) base *= 2;
    if (m.halfMore) base += Math.floor(base / 2);
    if (m.halve) base = Math.floor(base / 2);
    base = hasDice ? Math.max(1, base) : 0;
    const one = hasDice && dmg.amount === 1;
    const amped = hasDice ? amplifyDice(base, dmg.dice, pts.ampGroups + (m.groups ?? 0)) : { amount: 0, bonus: 0 };
    const keepHigh = pts.ampReroll || helpOneDie || beast || !!m.keepHigh || (!!m.halfMore && one);
    const keepLow = pts.redReroll || !!m.keepLow || (!!m.halve && one);
    return {
      a, rd,
      amount: amped.amount + helpExtra + ownBoost,
      flat: amped.bonus + (pts.ampFlat ? aProfHalf : 0) - (pts.redFlat ? aProfHalf : 0) + (m.flat ?? 0),
      reroll: keepHigh && !keepLow ? 1 : keepLow && !keepHigh ? -1 : 0,
      halvings: pts.redHalvings,
    };
  };
  // what doesn't depend on the target
  const uMods = {
    // (Pursuit on the one leaving, Bolt Beak / Fishious Rend on the one coming in: dice doubled)
    mult: uDice.mult, add: uDice.add, double: aMods.double || uDice.double || !!opts.switchDouble, halfMore: aMods.halfMore || uDice.halfMore,
    halve: uDice.halve, groups: aMods.groups + (uDice.groups ?? 0), keepHigh: aMods.keepHigh || uDice.keepHigh, keepLow: aMods.keepLow, flat: aMods.flat,
  };
  const baseSpec = dmgSpec(amp, red, uMods);
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
  // Fury Attack, Bullet Seed, Rock Blast...: after a hit, a d8 says how many more strikes (sure-hit,
  // MOVE bonus only on the first). The 4 possible extra strikes are rolled now; the unused ones are dropped.
  const multi = mfx.multiTable && !opts.area && targetItems.length && move.attackBonus != null;
  const nHits = multi ? 5 : move.hits > 1 && !opts.area && targetItems.length ? move.hits : 1;
  if (!multi && nHits > 1 && targetItems.length > nHits) throw new Error(`${move.label}: são ${nHits} golpes, escolha até ${nHits} alvos.`);
  const seq = multi ? Array.from({ length: 5 }, (_, i) => ({ t: targetItems[0], strike: i }))
    : nHits > 1 ? Array.from({ length: nHits }, (_, i) => ({ t: targetItems[i % targetItems.length], strike: i })) : targetItems.map((t) => ({ t, strike: 0 }));
  if (nHits > 1 && !multi) entry.notes.push(`${nHits} golpes${move.firstOnlyBonus ? " (bônus de MOVE só no 1º)" : ""}`);
  const multiDie = multi ? want({ amount: 1, sides: moveName === "Population Bomb" ? 20 : 8, bonus: 0 }) : null;
  const skillLink = aAbil.includes("Skill Link");
  // sure-hit moves (Swift, Aerial Ace): a d20 per target only for the critical
  if (move.sureHit && targetItems.length) entry.notes.push("acerto garantido (o d20 só decide o crítico)");
  // Supercell Slam / Jump Kick: a miss hurts the user; Fusion Bolt/Flare is remembered for the other
  const priority = Number(/Prioridade\s*(-?\d)/i.exec(raw.Description ?? "")?.[1] ?? 0);
  // distances from each target to the others (Friend Guard, Armor Tail, the Ruin abilities)
  const distTo = new Map();
  // the field where each target stands (screens, Safeguard, Mist, terrain, weather around it)
  const tFields = new Map();
  for (const t of new Set(seq.map((x) => x.t))) tFields.set(t.id, await fieldNow(null, null, t));
  for (const t of new Set(seq.map((x) => x.t))) {
    const m = new Map();
    for (const o of others) m.set(o.item.id, o.item.id === t.id ? 0 : await distanceMeters(t, o.item));
    distTo.set(t.id, m);
  }

  let plans = seq.map(({ t, strike }) => {
    const tSheet = getSheet(t);
    const target = tSheet?.pkmn;
    const far = farFromFlier.has(t.id);
    // the target's abilities against this move, and the dice that depend on the target
    const tCtx = { field, melee, type: move.type, moldBreaker: aMods.moldBreaker, gas, ally: tSheet ? allies(aSheet, tSheet) : false,
      eff: target ? rules.effectiveness(move.type, target) : 1, priority,
      others: [{ item: attackerItem, sheet: aSheet, dist: 0, ally: true }, ...others].map((o) => ({ ...o, allyOfTarget: tSheet ? allies(o.sheet, tSheet) && o.item.id !== t.id : false,
        distToTarget: o.item.id === attackerItem.id ? (others.find((x) => x.item.id === t.id)?.dist ?? 0) : distTo.get(t.id)?.get(o.item.id) ?? 99 })) };
    const tm = targetMods(rules, aSheet, tSheet, move, raw, tCtx);
    const td = MFX.targetDice(rules, aSheet, tSheet, attackerItem, t, move, mfx, { field, others });
    const extraStrike = multi && strike > 0;
    const sureNow = extraStrike || move.sureHit || aMods.noGuard || tm.sure || uDice.sure || td.sure;
    const saveAdv = Math.max(-1, Math.min(1, (tSheet && move.save ? saveAdvantage(tSheet, move.save) : 0) + (far ? 1 : 0)));
    const saveMod = move.saveDC != null && target ? (rules.saves(target)[move.save] ?? 0) + stage(target, "Evasion") + tm.saveBonus : null;
    const adv = move.attackBonus != null && tSheet ? Math.max(-1, Math.min(1,
      attackAdvantage(aSheet, tSheet, attackerItem.id) + (diving ? 1 : 0) - (far ? 1 : 0) - (engaged ? 1 : 0)
      + (opts.opportunity && rules.hasFeat(attacker, "Mestre de Combate Corpo a Corpo") ? 1 : 0))) : 0;
    const inv = invulnCheck(tSheet, moveName);
    const contestMod = fx.contest && target ? mod(rules.attributes(target)[fx.contest.attr] ?? 10) : null;
    // damage this target receives: its own "dano recebido" points join the attacker's
    const inA = tSheet?.battle?.ampIn ?? 0, inR = (tSheet?.battle?.redIn ?? 0) + tm.redPoints;
    const tMods = { ...uMods, double: uMods.double || td.double, add: uMods.add + td.add, groups: uMods.groups + (td.groups ?? 0),
      keepHigh: uMods.keepHigh || tm.keepHigh, keepLow: uMods.keepLow || tm.keepLow };
    const spec0 = dmgSpec(amp + inA, red + inR, tMods);
    // Triple Axel: the 2nd strike rolls twice the dice, the 3rd three times; the MOVE bonus only on the 1st
    // (Fury Attack & co.: the extra strikes roll the base dice, without MOVE)
    const cutMove = (move.firstOnlyBonus || multi) && strike > 0 ? (dmg?.moveMod ?? 0) : 0;
    const spec = nHits > 1 ? { ...spec0, amount: spec0.amount * (move.scaleDice ? strike + 1 : 1), cut: cutMove } : spec0;
    for (const n of [...tm.notes, ...td.notes]) if (!entry.notes.includes(n)) entry.notes.push(`${t.name}: ${n}`);
    return {
      t, tSheet, target, saveMod, adv, saveAdv, inv, spec, strike, tm, sureNow, extraStrike,
      dmg2: inv?.double && hasDice ? Array.from({ length: dmg.times }, () => want({ amount: spec.amount, sides: dmg.dice, bonus: 0 })) : null,
      // Punishment: +1 die per positive stage of the target (max 7)
      boost: fx.dicePerTargetBoost && hasDice && target ? (() => {
        const k = Math.min(fx.dicePerTargetBoost, Object.values(Array.isArray(target.stages) ? {} : target.stages ?? {}).reduce((a, v) => a + Math.max(0, v), 0));
        return k ? want({ amount: k, sides: dmg.dice, bonus: 0 }) : null;
      })() : null,
      // team/owner travel with the result so each viewer can hide what they shouldn't see
      r: { targetId: t.id, target: `${t.name || (target ? rules.name(target) : "Alvo")}${nHits > 1 ? ` (${strike + 1}º golpe)` : ""}`, effects: [], team: tSheet ? teamOf(tSheet) : null, owner: tSheet?.owner ?? null },
      atk: move.attackBonus != null && !extraStrike ? want({ amount: adv ? 2 : 1, sides: 20, bonus: move.attackBonus }) : null,
      sure: (move.sureHit && move.attackBonus == null) || extraStrike ? want({ amount: 1, sides: 20, bonus: 0 }) : null,
      // the waiting die was already rolled; chips roll theirs in this throw
      help: helpSides && !pendingHelp?.die && move.attackBonus != null ? want({ amount: 1, sides: helpSides, bonus: 0 }) : null,
      helpFixed: move.attackBonus != null ? Math.max(pendingHelp?.die ?? 0, 0) : 0,
      sav: saveMod != null ? want({ amount: saveAdv ? 2 : 1, sides: 20, bonus: saveMod }) : null,
      // (Taunt, Encore, Disable, Curse, Memento: the contest decides the move's own effect)
      con: fx.contest && (fx.contest.status || fx.contest.stages.length || mfx.restrict || mfx.curse || mfx.selfKOOnSuccess) ? want({ amount: 1, sides: 20, bonus: 0 }) : null,
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
      const ac = target ? rules.ac(target) + stage(target, "Evasion") + p.tm.acBonus : null;
      p.crit = n >= critAt;
      // acerto garantido (No Guard, Minimize, Thunder in the rain...): the d20 only for the crit
      const hit = p.sureNow || (n !== 1 && (p.crit || ac == null || total >= ac));
      r.attack = { nat: n, total, ac, crit: p.crit, hit, fumble: !p.sureNow && n === 1, adv: p.adv > 0, help: bonus || null, ...(p.sureNow ? { sure: true } : {}) };
      if (!hit) p.hitFactor = 0;
    } else if (p.sure != null) {
      // acerto garantido: always hits, even on a natural 1; the d20 only for the critical
      const n = dice(p.sure)[0];
      p.crit = n >= critAt;
      r.attack = { nat: n, total: null, ac: null, crit: p.crit, hit: true, fumble: false, adv: false, help: null, sure: true };
    }
    // Merciless: a hit on a poisoned target is a critical hit
    if (p.tm.mercy && r.attack?.hit && !p.crit) { p.crit = true; r.attack.crit = true; r.effects.push("crítico (Merciless: alvo envenenado)"); }
    // the target's abilities: Levitate, Volt Absorb, Bulletproof, Soundproof, Telepathy, Magic Bounce...
    if (p.tm.immune && !p.tm.bounce) { p.hitFactor = 0; p.immune = true; r.effects.push(`imune (${p.tm.immune})`); }
    if (dc != null && (p.atk == null || r.attack.hit)) {
      const attr = ATTR_PT[move.save] ?? move.save;
      const effectOnly = p.atk != null; // attack + save (e.g. Acid Spray): the save is for the secondary effect
      if (p.sav != null) {
        const n = pick(p.sav, p.saveAdv);
        // natural 20 always passes (and takes no damage), natural 1 always fails (and is a critical hit)
        // a Helping Hand die waiting on the target also goes into its save
        const hb = p.tSheet?.battle?.helped?.die ?? 0;
        if (hb) change(p.t.id).clearHelp = true;
        // No Guard (either side) / Blizzard in hail: damaging save moves always do full damage
        const forceFail = !effectOnly && move.damage && (aMods.noGuard || p.tm.sure || (mfx.hailSure && field.weather === "hail"));
        const success = !forceFail && (n === 20 || (n !== 1 && n + p.saveMod + hb >= dc));
        r.save = { attr, nat: n, total: n + p.saveMod + hb, dc, success, effectOnly, dis: p.saveAdv < 0, help: hb || null };
        if (!effectOnly && !p.immune) {
          if (n === 20 && !forceFail) p.hitFactor = 0;
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

  // Fury Attack & co.: how many extra strikes (only after the first one hits); Triple Kick: stops at a miss
  if (multi) {
    const first = plans[0];
    const n = dice(multiDie)[0];
    const extra = first.r.attack?.hit ? (skillLink ? 4 : MFX.extraStrikes(moveName === "Population Bomb" ? Math.ceil((n * 8) / 20) : n, false)) : 0;
    if (first.r.attack?.hit) entry.notes.push(skillLink ? "Skill Link: 4 golpes extras" : `d${moveName === "Population Bomb" ? 20 : 8} = ${n}: ${extra} golpe(s) extra(s)`);
    const drop = plans.filter((p) => p.strike > extra);
    plans = plans.filter((p) => p.strike <= extra);
    for (const p of drop) entry.results.splice(entry.results.indexOf(p.r), 1);
    plans.forEach((p) => { p.r.target = `${p.t.name}${extra ? ` (${p.strike + 1}º golpe)` : ""}`; });
  } else if (move.stopOnMiss && nHits > 1) {
    const missAt = plans.findIndex((p) => p.r.attack && !p.r.attack.hit);
    if (missAt >= 0) {
      const drop = plans.slice(missAt + 1);
      plans = plans.slice(0, missAt + 1);
      for (const p of drop) entry.results.splice(entry.results.indexOf(p.r), 1);
      if (drop.length) entry.notes.push("errou: os golpes seguintes não acontecem");
    }
  }
  anyHit = plans.some((p) => p.hitFactor > 0 && (p.atk == null || p.r.attack?.hit));

  // critical hits roll only their extra dice, in a second (small) throw
  // (Battle Armor / Shell Armor: no extra dice; Sniper: twice the extra dice; Fickle Beam 15+: doubled dice too)
  const sniper = aAbil.includes("Sniper");
  for (const p of plans) {
    const fickle = mfx.fickle && (p.r.attack?.nat ?? 0) >= 15 && p.r.attack?.hit;
    p.extraSets = (p.crit && !p.tm.noCritExtra ? (sniper ? 2 : 1) : 0) + (fickle ? (p.crit ? 2 : 1) : 0);
    if (fickle) p.r.effects.push("Fickle Beam: dados dobrados");
  }
  const crits = plans.filter((p) => p.extraSets > 0 && p.dmg && p.hitFactor > 0);
  const critRolls = crits.length ? await roller.batch(crits.flatMap((p) => p.dmg.flatMap(() => Array.from({ length: p.extraSets }, () => ({ amount: p.spec.amount, sides: dmg.dice, bonus: 0 })))), `${moveName_} CRÍTICO`) : [];

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
      if (p.extraSets > 0 && p.dmg) {
        const extra = p.dmg.map(() => Array.from({ length: p.extraSets }, () => critRolls[c++].dice).flat());
        roll = { dice: roll.dice.map((d0, i) => [...d0, ...extra[i]]), total: roll.total + extra.flat().reduce((a, b) => a + b, 0) };
      }
      // Ataque/Ataque Especial: + stage x proficiency (a crit ignores the attacker's negative stages)
      // (Foul Play: the target's Attack; Unaware on the target: the attacker's stages don't count)
      const tAbil = p.tSheet ? abilitiesOf(rules, p.tSheet, { gas }) : [];
      let atkStage = mfx.foul && p.target ? stage(p.target, "Attack") : stage(attacker, atkStageKey);
      if (tAbil.includes("Unaware") && !aMods.moldBreaker) atkStage = 0;
      if (p.crit && atkStage < 0) atkStage = 0;
      // Mestre de Combate: +10 once (on a save move, only when the target failed); Investida Poderosa +5
      const featDmg = (power && (move.attackBonus != null || p.hitFactor === 1) ? 10 : 0) + chargeBonus;
      let total = roll.total + atkStage * aProf + featDmg;
      if (burned && melee) total = Math.floor(total / 2); // Queimado: melee damage halved
      // "Ordem da entrada de dano" (pág. 55): ... 8. Defesa/Defesa Especial do alvo,
      // 9. vulnerabilidades e resistências por último
      let eff = p.target ? rules.effectiveness(move.type, p.target) : 1;
      // Scrappy: Normal/Fighting hit Ghosts (the Ghost part counts as neutral)
      if (eff === 0 && aMods.scrappy && p.target) eff = rules.typeMult(move.type, rules.types(p.target).filter((t0) => t0 !== "Ghost"));
      if (aMods.ignoreResist && eff > 0 && eff < 1) eff = 1; // Tinted Lens
      if (p.tm.effAdj) eff = p.tm.effAdj(eff); // Filter / Solid Rock / Prism Armor
      let final = Math.max(0, total);
      if (p.target) {
        // Psyshock: the target's Defense even though it's ranged; Unaware (attacker): its stages don't count
        let defStage = stage(p.target, mfx.defAs ?? (melee ? "Defense" : "SpecialDefense"));
        if (aAbil.includes("Unaware")) defStage = 0;
        if (p.crit && defStage > 0) defStage = 0; // a crit ignores the defender's positive stages
        final = Math.max(0, final - defStage * rules.proficiency(p.target));
      }
      final = Math.floor(final * eff);
      if (p.hitFactor === 0.5) final = Math.floor(final / 2);
      // abilities and field after the type: Thick Fat, Fur Coat, Fluffy...; Defeatist; Solar Beam in the rain
      final = Math.floor(final * p.tm.mult * uDice.finalMult * (aMods.halveFinal ? 0.5 : 1));
      // Reflect / Light Screen / Aurora Veil on the target's side (not against crits; Infiltrator ignores)
      const side = p.tSheet && (tFields.get(p.t.id) ?? field).sides?.[teamOf(p.tSheet)];
      if (side && !p.crit && !aMods.infiltrator && !allies(aSheet, p.tSheet)
        && ((melee && side.reflect) || (!melee && side.lightScreen) || side.auroraVeil)) {
        final = Math.floor(final / 2);
        p.r.effects.push(`${side.auroraVeil ? "Aurora Veil" : melee ? "Reflect" : "Light Screen"}: dano pela metade`);
      }
      if (p.tm.red) final = Math.max(0, final - p.tm.red);
      // Redução: each 2 points halve the final damage (the target's "dano recebido" points count here too)
      const halvings = p.dmg ? p.spec.halvings : pointsSummary(0, red + (p.tSheet?.battle?.redIn ?? 0) + p.tm.redPoints).redHalvings;
      for (let i = 0; i < halvings; i++) final = Math.floor(final / 2);
      // Multiscale / Shadow Shield (full HP: the first hit halved), Sturdy (full HP: a big hit halved, never
      // from full to 0), Disguise / Ice Face (the first hit does nothing)
      if (p.target) {
        const chPrev = changes.get(p.t.id)?.damage ?? 0;
        const max = rules.maxHP(p.target);
        if (p.tm.firstHalf && !chPrev && final > 0) { final = Math.floor(final / 2); p.r.effects.push("Multiscale: metade do dano"); }
        if (p.tm.sturdy && !chPrev && final > max / 2) {
          final = Math.floor(final / 2);
          if (final >= p.target.hp.current) final = p.target.hp.current - 1;
          p.r.effects.push("Sturdy: aguentou");
        }
        if (p.tm.disguise && !changes.get(p.t.id)?.disguised && final > 0) {
          change(p.t.id).disguised = p.tm.disguise;
          p.r.effects.push(`${p.tm.disguise}: o disfarce absorveu o golpe`);
          final = 0;
        }
      }
      p.r.damage = { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus + (p.dmg ? p.spec : baseSpec).flat - (p.spec.cut ?? 0) + atkStage * aProf + featDmg, rolled: total, eff, effLabel: effLabel(eff), final, half: p.hitFactor === 0.5, shared: !!opts.area, crit: p.crit };
      if (p.target && settings.autoDamage && final > 0) {
        const ch = change(p.t.id);
        ch.damage += final;
        ch.hits = (ch.hits ?? 0) + 1;
        if (p.crit) { ch.wake = true; ch.crit = true; } // a critical hit wakes up / removes Sonolento
        if (move.type === "Fire") ch.thaw = true; // fire damage thaws
      }
    }
  }
  // fixed damage (Seismic Toss, Night Shade, Dragon Rage, Super Fang, Counter...): no dice, STAB,
  // crit nor resistances, but nothing against a type immunity
  if (mfx.fixed) {
    for (const p of plans) {
      if (!p.target || p.hitFactor === 0 || p.immune) continue;
      const eff = rules.effectiveness(move.type, p.target);
      const n = eff === 0 ? 0 : MFX.fixedDamage(rules, aSheet, p.tSheet, mfx, attackerItem, p.t) ?? 0;
      p.r.damage = { dice: [], sides: 0, bonus: n, rolled: n, eff: eff === 0 ? 0 : 1, effLabel: eff === 0 ? "imune" : "dano fixo", final: n, fixed: true };
      if (n > 0 && settings.autoDamage) { const ch = change(p.t.id); ch.damage += n; ch.hits = (ch.hits ?? 0) + 1; }
      if (mfx.fixed === "counter" && !n) p.r.effects.push("falhou (o alvo não te acertou com esse tipo de ataque por último)");
    }
  }
  // Endeavor / Final Gambit / Pain Split: decided by the target's save
  for (const p of plans) {
    if (!p.target || p.immune || !(mfx.endeavor || mfx.gamble || mfx.painSplit)) continue;
    const failed = p.r.save && !p.r.save.unknown && !p.r.save.success;
    if (!failed) { p.r.effects.push("passou no teste: não funcionou"); continue; }
    const lvl = rules.level(attacker);
    const ch = change(p.t.id);
    if (mfx.endeavor) { const n = Math.min(5 * lvl, Math.max(0, p.target.hp.current - attacker.hp.current)); ch.damage += n; p.r.effects.push(`Endeavor: −${n} HP`); }
    if (mfx.gamble) { ch.damage += attacker.hp.current; p.r.effects.push(`Final Gambit: −${attacker.hp.current} HP`); ch.gambleKO = true; }
    if (mfx.painSplit) {
      const avg = Math.floor((p.target.hp.current + attacker.hp.current) / 2);
      const loss = Math.min(5 * lvl, Math.max(0, p.target.hp.current - avg));
      ch.damage += loss; ch.heal = Math.max(0, avg - p.target.hp.current);
      ch.painSplitSelf = avg;
      p.r.effects.push(`Pain Split: os dois ficam com ${avg} HP`);
    }
  }

  // 5) effects from the move text
  const naturalSelf = [];
  // Sheer Force: no secondary effects; Serene Grace: the natural thresholds twice as wide (19 -> 17)
  const sec = !aMods.sheer;
  const natMin = fx.natural ? fx.natural.min - (aMods.serene ? 21 - fx.natural.min : 0) : 99;
  for (const p of plans) {
    if (!p.target) continue;
    // an ability made it immune: Volt Absorb heals, Flash Fire powers up, Sap Sipper raises Attack...
    if (p.immune) { if (p.tm.absorb) change(p.t.id).absorb = { ...p.tm.absorb, label: p.tm.immune }; continue; }
    // immune to the type of a damaging move: no damage and no secondary effects (pág. 55)
    const effNow = rules.effectiveness(move.type, p.target);
    if (dmg && effNow === 0 && !aMods.scrappy) continue;
    // Magic Bounce: a status move comes back to its user
    const ch = p.tm.bounce ? change(attackerItem.id) : change(p.t.id);
    if (p.tm.bounce) p.r.effects.push("Magic Bounce: devolvido");
    const hit = p.atk == null || p.r.attack.hit;
    const failed = p.r.save && !p.r.save.unknown && !p.r.save.success;
    const landed = hit && p.hitFactor > 0;
    if (landed || (p.r.contest?.success)) ch.from = attackerItem.id;
    // the move's own effects on this target (movefx.js)
    if (landed && mfx.seed && !rules.types(p.target).includes("Grass")) ch.seed = { by: attackerItem.id, team: teamOf(aSheet) };
    if (landed && mfx.seed && rules.types(p.target).includes("Grass")) p.r.effects.push("tipo Grama: imune a Leech Seed");
    if (mfx.yawn && landed && !move.save) ch.yawn = 2;
    if (mfx.clearTarget && landed) ch.clearStages = true;
    if (mfx.knockOff && landed && p.target.item && !p.tSheet.battle?.itemLost) ch.knockOff = true;
    if (mfx.breakScreens && landed) ch.breakScreens = true;
    if (mfx.clearTerrain === "hit" && landed && field.terrain) ch.clearTerrain = true;
    if (moveName === "Smelling Salts" && landed) ch.cure = ["Paralyzed"];
    if (moveName === "Wake-Up Slap" && landed) ch.cure = ["Asleep", "Drowsy"];
    if (mfx.leaveOne) ch.leaveOne = true;
    if (mfx.vortex && landed) ch.vortex = mfx.vortex;
    // Wrap, Bind, Clamp, Snap Trap, Thunder Cage, Octolock: held, hurt at the end of its turns
    if (mfx.bind && (move.save ? failed : landed)) ch.bind = { move: moveName_, by: attackerItem.id, octo: moveName === "Octolock" };
    if (mfx.restrict && (p.r.contest?.success || (!fx.contest && landed))) {
      ch.restrict = { kind: mfx.restrict, move: p.tSheet.battle?.lastMove ?? null, turns: mfx.restrict === "disable" ? 4 : 3 };
    }
    if (mfx.curse && rules.types(attacker).includes("Ghost") && p.r.contest?.success) {
      if (rules.level(p.target) > rules.level(attacker)) p.r.effects.push("Curse falhou (nível do alvo maior)");
      else ch.curse = true;
    }
    if (mfx.heal && !mfx.heal.self && landed && allies(aSheet, p.tSheet)) ch.healDice = mfx.heal;
    if (!sec) continue;
    // natural result on the attack roll ("mesmo que o golpe erre": Charge Beam)
    if (fx.natural && p.r.attack && (p.r.attack.hit || fx.natural.evenMiss) && p.r.attack.nat >= natMin) {
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
  // healing dice (Recover, Moonlight, Heal Pulse, Wish, Swallow...): one small throw
  const movePow = rules.movePower(attacker, raw, false) ?? 0;
  const lvlIdx = rules.levelIndex(attacker);
  let selfHeal = 0;
  const healSpec = (h) => {
    if (h.table) return MFX.tableHeal(raw, lvlIdx, field.weather);
    let amount = h.amount * (h.stockpile ? Math.max(1, aSheet.battle?.stockpile ?? 0) : 1);
    if (h.sandBonus && field.weather === "sand") amount += 1;
    return { amount, sides: h.sides };
  };
  const healTargets = [...changes.entries()].filter(([, ch]) => ch.healDice);
  const wantHeal = [];
  if (mfx.heal?.self && !(mfx.heal.stockpile && !aSheet.battle?.stockpile)) wantHeal.push({ who: "self", ...healSpec(mfx.heal) });
  for (const [id, ch] of healTargets) wantHeal.push({ who: id, ...healSpec(ch.healDice) });
  if (wantHeal.length) {
    const hr = await roller.batch(wantHeal.map((w) => ({ amount: w.amount, sides: w.sides, bonus: movePow })), `${moveName_} cura`);
    wantHeal.forEach((w, i) => {
      const n = hr[i].dice.reduce((a, b) => a + b, 0) + movePow;
      if (w.who === "self") selfHeal = n; else changes.get(w.who).healAmount = n;
    });
  }
  if (mfx.heal?.stockpile && !aSheet.battle?.stockpile) entry.notes.push("Swallow sem Stockpile: não cura");
  // Curse (Ghost user): its own HP; Memento / Final Gambit / explosions: the user faints
  const ghostCurse = mfx.curse && rules.types(attacker).includes("Ghost");
  if (ghostCurse) selfStages = [];
  const contestWon = plans.some((p) => p.r.contest?.success);
  const selfKO = mfx.selfKO || mfx.healingWish || (mfx.selfKOOnSuccess && contestWon) || [...changes.values()].some((c) => c.gambleKO);
  // Pressure: a single-target move at an enemy with Pressure costs 2 PP
  const pressure = !opts.area && targetItems.length === 1 && getSheet(targetItems[0]) && !allies(aSheet, getSheet(targetItems[0]))
    && abilitiesOf(rules, getSheet(targetItems[0]), { gas }).includes("Pressure");
  // (a charged / invulnerable move already used its PP when it was activated)
  const usesPP = !releasing && settings.autoPP && typeof move.pp === "number" && !!attacker.moves?.[moveName] && !aSheet.battle?.locked;
  const ppCost = pressure ? 2 : 1;
  if (pressure && usesPP) entry.notes.push("Pressure: gastou 2 PP");
  const missedAll = move.attackBonus != null && targetItems.length > 0 && !anyHit;
  await updateSheet(attackerItem.id, (s) => {
    if (usesPP) s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - ppCost);
    spend(s, cost);
    if (copyFrom) s.pkmn.stages = { ...copyFrom, ...(s.pkmn.stages?.CritMargin ? { CritMargin: s.pkmn.stages.CritMargin } : {}) };
    for (const st of selfStages) addStage(s.pkmn, st.stat, st.delta);
    const max = rules.maxHP(s.pkmn);
    if (fx.hpCost) { // Belly Drum: half of its max HP
      const c0 = Math.floor(max * fx.hpCost);
      s.pkmn.hp.current = Math.max(0, s.pkmn.hp.current - c0);
      entry.notes.push(`${who} perdeu ${c0} HP`);
    }
    if (fx.rest) { // Rest: 4d6 + MOVE, non-volatile conditions cured, sleeps
      for (const k of ["Burning", "Frozen", "Paralyzed", "Poisoned", "BadlyPoisoned", "Drowsy", "Asleep"]) clearCondition(s, k, { grace: false });
      const r0 = giveCondition(s, "Asleep", rules, {});
      if (r0.ok) entry.notes.push(`${who} dormiu`);
      else { selfHeal = 0; entry.notes.push(`Rest falhou: ${r0.reason}`); }
    }
    if (selfHeal && !mfx.heal?.delayed) {
      const before = s.pkmn.hp.current;
      s.pkmn.hp.current = Math.min(max, s.pkmn.hp.current + selfHeal);
      entry.notes.push(`${who} recuperou ${s.pkmn.hp.current - before} HP (${selfHeal} rolado)`);
    }
    if (selfHeal && mfx.heal?.delayed) { s.battle.wish = { turns: 2, amount: selfHeal }; entry.notes.push(`Wish: ${selfHeal} HP no fim do próximo turno`); }
    if (fx.refresh) { // Refresh: Queimado, Envenenado, Paralisado
      for (const k of ["Burning", "Poisoned", "BadlyPoisoned", "Paralyzed"]) if (clearCondition(s, k)) entry.notes.push(`${who} curou ${CONDITIONS[k].label}`);
    }
    if (fx.thawSelf && clearCondition(s, "Frozen")) entry.notes.push(`${who} descongelou`);
    // the move's own state on the user (movefx.js)
    if (mfx.sub) {
      const c0 = Math.floor(max / 4);
      if (s.battle.sub) entry.notes.push("já tem um Substitute");
      else if (s.pkmn.hp.current <= c0) entry.notes.push("Substitute falhou: HP insuficiente");
      else { s.pkmn.hp.current -= c0; s.battle.sub = c0; entry.notes.push(`🧸 Substitute com ${c0} HP (−${c0} HP)`); }
    }
    if (mfx.stockpile) { s.battle.stockpile = Math.min(3, (s.battle.stockpile ?? 0) + 1); entry.notes.push(`Stockpile ${s.battle.stockpile}`); }
    if ((mfx.spitUp || mfx.heal?.stockpile) && s.battle.stockpile) {
      addStage(s.pkmn, "Defense", -s.battle.stockpile); addStage(s.pkmn, "SpecialDefense", -s.battle.stockpile);
      delete s.battle.stockpile;
    }
    if (mfx.charge) { s.battle.charged = "Charge"; s.battle.chargedUntil = (s.battle.turns ?? 0) + 1; }
    else if (s.battle.charged && move.damage && move.type === "Electric") delete s.battle.charged; // used up
    if (mfx.defenseCurl) s.battle.defenseCurl = true;
    if (mfx.minimize) s.battle.minimized = true;
    if (mfx.roost) { s.battle.roosted = true; entry.notes.push("Roost: sem voo e sem o tipo Voador até o próximo turno"); }
    if (mfx.magnetRise) { s.battle.magnetRise = 5; entry.notes.push("Magnet Rise: flutua (imune a Terra)"); }
    if (mfx.lock && !s.battle.locked) { s.battle.locked = { move: moveName, left: d(2) + 1 }; entry.notes.push(`${moveName}: em frenesi por mais ${s.battle.locked.left - 1} turno(s), depois fica confuso`); }
    if (mfx.furyCutter) s.battle.furyCutter = anyHit ? (s.battle.furyCutter ?? 0) + 1 : 0; else delete s.battle.furyCutter;
    if (ghostCurse && contestWon) {
      const c0 = Math.max(4, 2 * rules.level(s.pkmn));
      s.pkmn.hp.current = Math.max(0, s.pkmn.hp.current - c0);
      entry.notes.push(`${who} pagou ${c0} HP pela maldição`);
    }
    const ps = [...changes.values()].find((c) => c.painSplitSelf != null);
    if (ps) s.pkmn.hp.current = Math.min(max, ps.painSplitSelf);
    if (selfKO && s.pkmn.hp.current > 0) { s.pkmn.hp.current = 0; entry.notes.push(`${who} desmaiou (${moveName_})`); }
    s.battle.lastMove = moveName;
    if (move.attackBonus != null && targetItems.length) s.battle.lastMissed = missedAll; // Temper Flare, Stomping Tantrum
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
  if (usesPP) entry.pp = `${move.pp - ppCost}/${move.ppMax}`;
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
  // what comes back to the user after the targets are written: contact abilities, Synchronize,
  // Mirror Armor, drain and recoil, KO triggers
  const back = { stages: [], give: [], damage: [], set: {}, notes: [] };
  const fieldOps = [];
  let dealt = 0, drained = 0;
  const infiltrator = aMods.infiltrator;
  for (const [id, ch] of changes) {
    const keys = Object.keys(ch).filter((k) => !["give", "stages", "damage"].includes(k));
    if (!ch.damage && !ch.give.length && !ch.stages.length && !keys.length) continue;
    const self = id === attackerItem.id;
    const r = entry.results.find((x) => x.targetId === id) ?? { effects: entry.notes };
    const tItem = targetItems.find((t) => t.id === id) ?? (self ? attackerItem : null);
    const ownTurn = isActive(tItem);
    await updateSheet(id, (s, dr) => {
      const tAb = abilitiesOf(rules, s, { gas });
      const tGround = grounded(s, tAb);
      const max = rules.maxHP(s.pkmn);
      const hpBefore = s.pkmn.hp.current;
      // Sentinela: the hit pulls the creature back to where it left the reach, and it stops there
      if (ch.stop && opts.oaBack && dr) {
        dr.position = { ...opts.oaBack };
        s.battle.move = { used: 0, ...(s.battle.move ?? {}), pos: { ...opts.oaBack } };
        r.effects.push("puxado de volta pro alcance (Sentinela)");
      }
      // an ability absorbed the move (Volt Absorb, Flash Fire, Sap Sipper...)
      if (ch.absorb) {
        if (ch.absorb.heal) { s.pkmn.hp.current = Math.min(max, s.pkmn.hp.current + ch.absorb.heal); r.effects.push(`+${ch.absorb.heal} HP`); }
        for (const st of ch.absorb.stages ?? []) { addStage(s.pkmn, st.stat, st.delta); r.effects.push(stageText([st])); }
        if (ch.absorb.flag) s.battle[ch.absorb.flag] = true;
      }
      let dmgNow = ch.damage;
      // Substitute takes the hit (sound moves and Infiltrator go through)
      if (dmgNow && s.battle.sub && !self && !isSound(raw) && !infiltrator) {
        s.battle.sub -= dmgNow;
        r.effects.push(s.battle.sub > 0 ? `o Substitute aguentou (${s.battle.sub} HP)` : "o Substitute quebrou");
        if (s.battle.sub <= 0) delete s.battle.sub;
        dmgNow = 0;
      }
      if (ch.leaveOne && dmgNow >= s.pkmn.hp.current + (s.pkmn.hp.temp ?? 0) && s.pkmn.hp.current > 0) { dmgNow = Math.max(0, s.pkmn.hp.current + (s.pkmn.hp.temp ?? 0) - 1); r.effects.push("ficou com 1 HP"); }
      if (ch.disguised === "Disguise") s.battle.disguiseBroken = true;
      if (ch.disguised === "Ice Face") s.battle.iceFaceBroken = true;
      if (dmgNow) {
        takeDamage(s.pkmn, dmgNow);
        // Illusion: taking damage breaks it (the token shows the real Pokémon again)
        if (!self && dr && dropIllusionDraft(s, dr)) r.effects.push(`a ilusão se desfez: era ${dr.name}!`);
        if (!self) {
          s.battle.lastHit = { by: attackerItem.id, round, amount: dmgNow, melee };
          dealt += Math.min(dmgNow, hpBefore);
          // drain from this target (Liquid Ooze turns it into damage)
          if (mfx.drain) {
            const n = mfx.drain.up ? Math.ceil(Math.min(dmgNow, hpBefore) / 2) : Math.floor(Math.min(dmgNow, hpBefore) / 2);
            drained += tAb.includes("Liquid Ooze") ? -n : n;
          }
        }
      }
      if (ch.healAmount) { const b0 = s.pkmn.hp.current; s.pkmn.hp.current = Math.min(max, s.pkmn.hp.current + ch.healAmount); r.effects.push(`+${s.pkmn.hp.current - b0} HP`); }
      if (ch.heal) s.pkmn.hp.current = Math.min(max, s.pkmn.hp.current + ch.heal);
      const ko = hpBefore > 0 && s.pkmn.hp.current <= 0;
      if (ko && !self) { s.battle.koBy = attackerItem.id; s.battle.koRound = round; }
      if (ch.clearHelp) delete s.battle.helped; // its Helping Hand die went into this save
      if (ch.syrup) { s.battle.syrup = ch.syrup; r.effects.push(`coberto de xarope (−1 Velocidade por turno, ${ch.syrup} turnos)`); }
      if (ch.cureBurn && clearCondition(s, "Burning")) r.effects.push("queimadura curada");
      for (const k of ch.cure ?? []) if (clearCondition(s, k)) r.effects.push(`${CONDITIONS[k].label} curado`);
      if (ch.stop) { s.battle.move = { used: 0, ...(s.battle.move ?? {}), stopped: true }; r.effects.push("parado (Sentinela)"); }
      if (ch.seed) { s.battle.seeded = ch.seed; r.effects.push("🌱 semeado (Leech Seed)"); }
      if (ch.yawn) { s.battle.yawn = ch.yawn; r.effects.push("🥱 vai dormir no fim do próximo turno (Yawn)"); }
      if (ch.curse) { s.battle.cursed = true; r.effects.push("👻 amaldiçoado"); }
      if (ch.bind && s.pkmn.hp.current > 0) {
        s.battle.cond = conditionsOf(s);
        s.battle.cond.Grappled = { since: s.battle.turns ?? 0, age: 0, by: ch.bind.by };
        s.battle.bound = ch.bind;
        r.effects.push(`🤼 preso por ${ch.bind.move} (dano no fim de cada turno dele)`);
      }
      if (ch.clearStages) { s.pkmn.stages = {}; r.effects.push("estágios zerados"); }
      if (ch.knockOff) {
        s.battle.itemLost = true;
        r.effects.push(`perdeu o item (${s.pkmn.item}) até o fim da batalha`);
        if (tAb.includes("Unburden")) s.battle.unburden = true;
      }
      if (ch.restrict) {
        const kind = ch.restrict.kind;
        if ((kind === "disable" || kind === "encore") && !ch.restrict.move) r.effects.push(`${moveName_}: o alvo ainda não usou nenhum Move`);
        else if (tAb.includes("Aroma Veil") || tAb.includes("Oblivious") && kind === "taunt") r.effects.push(`${tAb.includes("Aroma Veil") ? "Aroma Veil" : "Oblivious"}: imune`);
        else {
          s.battle.restrict = { ...(s.battle.restrict ?? {}), [kind]: { turns: ch.restrict.turns, move: ch.restrict.move } };
          r.effects.push({ taunt: "provocado: só Moves de dano (3 turnos)", encore: `Encore: só ${ch.restrict.move} (3 turnos)`, disable: `${ch.restrict.move} bloqueado (4 turnos)`, torment: "Torment: não repete Move (3 turnos)", healBlock: "Heal Block: sem cura (3 turnos)" }[kind]);
        }
      }
      // charging / Focus Punch: concentration (CON save, DC 10 or half the damage)
      const c = s.battle.charging;
      if (c && !c.invuln && dmgNow > 0 && s.pkmn.hp.current > 0) {
        const dc0 = Math.max(10, Math.floor(dmgNow / 2));
        const n = d(20), total = n + (rules.saves(s.pkmn).CON ?? 0);
        if (n !== 20 && (n === 1 || total < dc0)) { delete s.battle.charging; r.effects.push(`perdeu a concentração em ${c.move} (CON ${total} vs CD ${dc0})`); }
        else r.effects.push(`manteve a concentração (CON ${total} vs CD ${dc0})`);
      }
      if (ch.smack) {
        if (s.battle.charging?.invuln) { r.effects.push(`${s.battle.charging.move} cancelado`); delete s.battle.charging; }
        s.battle.grounded = true;
        s.battle.prone = true;
        r.effects.push("derrubado ao chão");
      }
      if (ch.wake && dmgNow) { if (clearCondition(s, "Asleep")) r.effects.push("acordou com o crítico"); if (clearCondition(s, "Drowsy")) r.effects.push("não está mais sonolento"); }
      if (ch.thaw && dmgNow && clearCondition(s, "Frozen")) r.effects.push("descongelou com o fogo");
      // conditions: type immunity, abilities (Limber, Insomnia...), Safeguard, Misty Terrain, Substitute
      const block = (key) => statusBlock(rules, s, key, { field: tFields.get(id) ?? field, grounded: tGround, team: teamOf(s), fromOther: !self, source: { infiltrator, secondary: !!move.damage }, gas });
      for (const key of [...new Set(ch.give)]) {
        if (s.pkmn.hp.current <= 0) break;
        const res = giveCondition(s, key, rules, { ownTurn, block, corrosion: aAbil.includes("Corrosion") });
        r.effects.push(res.ok ? `ficou ${CONDITIONS[res.became ?? key].label}` : `${CONDITIONS[key].label}: ${res.reason}`);
        if (res.ok) {
          const oc = onCondition(rules, s, res.became ?? key);
          for (const st of oc.stages) addStage(s.pkmn, st.stat, st.delta);
          if (oc.notes.length) r.effects.push(oc.notes.join(", "));
          if (oc.back && !self) { back.give.push(oc.back); back.notes.push(`Synchronize de ${tItem?.name}`); }
        }
      }
      // stages from someone else: Clear Body, Hyper Cutter, Contrary, Simple, Mist, Defiant, Mirror Armor...
      if (ch.stages.length) {
        const g = stageGuard(rules, s, ch.stages, { fromOther: !self, field: tFields.get(id) ?? field, team: teamOf(s), infiltrator, gas });
        for (const st of g.list) addStage(s.pkmn, st.stat, st.delta);
        if (g.list.length) r.effects.push(stageText(g.list));
        if (g.notes.length) r.effects.push(g.notes.join(", "));
        back.stages.push(...g.reflect);
      }
      // abilities once the hit landed: contact (Static, Rough Skin...), Stamina, Justified, Moxie...
      if (!self && move.damage && dmgNow > 0) {
        const hits = Math.max(1, ch.hits ?? 1);
        for (let i = 0; i < hits; i++) {
          const ops = afterHit(rules, aSheet, s, move, raw, {
            melee, noContact: aMods.noContact, crit: !!ch.crit, hpBefore, hpAfter: s.pkmn.hp.current, ko: ko && i === hits - 1,
            natural: plans.find((p) => p.t.id === id)?.r.attack?.nat ?? 0, saveNat: plans.find((p) => p.t.id === id)?.r.save?.nat ?? null,
            type: move.type, damaged: true, gas,
          });
          for (const op of ops.T) {
            if (op.stages) for (const st of op.stages) addStage(s.pkmn, st.stat, st.delta);
            if (op.give) { const res = giveCondition(s, op.give, rules, { ownTurn, block }); if (res.ok) r.effects.push(`ficou ${CONDITIONS[op.give].label}`); }
            if (op.set) Object.assign(s.battle, op.set);
            if (op.field) fieldOps.push({ ...op.field, by: tItem?.name ?? "", user: tItem, ability: op.note });
            if (op.note && (op.stages || op.give || op.set || !op.field)) r.effects.push(op.note + (op.stages ? ` (${stageText(op.stages)})` : ""));
          }
          for (const op of ops.A) {
            if (op.stages) back.stages.push(...op.stages);
            if (op.give) back.give.push(op.give);
            if (op.damage) back.damage.push(op.damage);
            if (op.set) Object.assign(back.set, op.set);
            if (op.note) back.notes.push(`${op.note}${op.damage ? ` −${op.damage} HP` : ""}${op.give ? `: ${CONDITIONS[op.give].label}` : ""}${op.stages ? ` (${stageText(op.stages)})` : ""}`);
          }
        }
      }
    });
    const after = getSheet((await OBR.scene.items.getItems([id]))[0]);
    if (after && r && r.targetId) {
      r.hpAfter = `${after.pkmn.hp.current}/${rules.maxHP(after.pkmn)}`;
      if (after.pkmn.hp.current <= 0 && !r.effects.includes("DESMAIOU")) r.effects.push("DESMAIOU");
    }
    const tNow = (await OBR.scene.items.getItems([id]))[0];
    if (ch.breakScreens && after) { if (await clearSide(teamOf(after), ["reflect", "lightScreen", "auroraVeil"], tNow)) entry.notes.push("as telas do alvo quebraram"); }
    if (ch.clearTerrain) { await clearTerrain(tNow); entry.notes.push("o terreno foi desfeito"); }
    // Whirlpool, Fire Spin, Sand Tomb...: a vortex under the target for 5 rounds
    if (ch.vortex && tNow && !self) {
      const n = await startField({ vortex: ch.vortex, rounds: 5, r: 0.75, at: "target" }, { user: (await OBR.scene.items.getItems([attackerItem.id]))[0], target: tNow, move: moveName_, by: who });
      if (n) entry.notes.push(`${moveName_}: redemoinho em ${tNow.name} (5 rodadas)`);
    }
  }

  // drain, recoil, the miss of Jump Kick/Supercell Slam, and what came back from the targets
  const aAfter = getSheet((await OBR.scene.items.getItems([attackerItem.id]))[0]);
  if (aAfter && aAfter.pkmn.hp.current > 0 || drained || back.damage.length) {
    const magic = aAbil.includes("Magic Guard");
    const recoil = mfx.recoil && dealt > 0 && !aAbil.includes("Rock Head") && !magic ? Math.floor(dealt * mfx.recoil) : 0;
    const missHurt = mfx.missRecoil && missedAll && !magic
      ? (mfx.missRecoil === "2lvl" ? Math.max(4, 2 * rules.level(attacker)) : Math.floor(rules.maxHP(attacker) / 2)) : 0;
    if (drained || recoil || missHurt || back.damage.length || back.give.length || back.stages.length || Object.keys(back.set).length) {
      await updateSheet(attackerItem.id, (s) => {
        const max = rules.maxHP(s.pkmn);
        if (drained > 0) { const b0 = s.pkmn.hp.current; s.pkmn.hp.current = Math.min(max, s.pkmn.hp.current + drained); entry.notes.push(`${who} drenou ${s.pkmn.hp.current - b0} HP`); }
        if (drained < 0) { takeDamage(s.pkmn, -drained); entry.notes.push(`Liquid Ooze: ${who} perdeu ${-drained} HP`); }
        if (recoil) { takeDamage(s.pkmn, recoil); entry.notes.push(`${who} sofreu ${recoil} de recuo`); }
        if (missHurt) { takeDamage(s.pkmn, missHurt); entry.notes.push(`${who} errou e sofreu ${missHurt} de dano`); }
        for (const n of back.damage) takeDamage(s.pkmn, n);
        const block = (key) => statusBlock(rules, s, key, { field, grounded: aGrounded, team: teamOf(s), fromOther: true, source: {}, gas });
        for (const key of [...new Set(back.give)]) giveCondition(s, key, rules, { ownTurn: isActive(attackerItem), block });
        const g = stageGuard(rules, s, back.stages, { fromOther: true, field, team: teamOf(s), gas });
        for (const st of g.list) addStage(s.pkmn, st.stat, st.delta);
        Object.assign(s.battle, back.set);
        if (s.pkmn.hp.current <= 0) entry.notes.push(`${who} desmaiou`);
      });
    }
    if (back.notes.length) entry.notes.push(...back.notes.map((n) => `${who}: ${n}`));
  }

  // field moves and effects on several creatures
  const fieldMove = FIELD_MOVES[moveName];
  // (an area on the map: weather/Tailwind follow the user, terrain/screens stay here, hazards on the target)
  const userNow = (await OBR.scene.items.getItems([attackerItem.id]))[0] ?? attackerItem;
  if (fieldMove) { const n = await startField(fieldMove, { team: teamOf(aSheet), by: who, user: userNow, target: targetItems[0] ?? null, move: moveName_ }); if (n) entry.notes.push(n); }
  for (const op of fieldOps) {
    const spec = op.weather ? { weather: op.weather, r: 15, follow: true } : { terrain: op.terrain, r: 12 };
    const n = await startField({ ...spec, rounds: 5 }, { by: op.by, user: op.user, move: op.ability });
    if (n) entry.notes.push(`${op.by}: ${n}`);
  }
  if (mfx.clearTerrain === "before") { await clearTerrain(userNow); entry.notes.push("o terreno foi desfeito"); }
  if (mfx.fusion) { const f = await getField(); f.fusion = { move: moveName, round }; await OBR.scene.setMetadata({ "com.pmp-fichas/field": f }); }
  if (mfx.haze || mfx.cureTeam || mfx.perish) {
    const radius = mfx.haze ?? mfx.cureTeam ?? 18;
    const near = [{ item: attackerItem, sheet: aSheet, dist: 0, ally: true }, ...others].filter((o) => o.dist <= radius + 0.05);
    for (const o of near) {
      if (mfx.cureTeam && !o.ally) continue;
      if (mfx.perish && (o.sheet.battle?.perish != null || abilitiesOf(rules, o.sheet, { gas }).includes("Soundproof"))) continue;
      await updateSheet(o.item.id, (s) => {
        if (mfx.haze) s.pkmn.stages = {};
        if (mfx.cureTeam) for (const k of Object.keys(conditionsOf(s))) clearCondition(s, k, { grace: false });
        if (mfx.perish) { s.battle.perish = 3; s.battle.perishLevelOver = rules.level(s.pkmn) > rules.level(attacker); }
      });
    }
    entry.notes.push(mfx.haze ? "todos os estágios em 12 m foram zerados" : mfx.cureTeam ? "aliados curados das condições" : `🎵 Perish Song: quem ouviu desmaia em 3 rodadas (${near.length})`);
  }
  if (mfx.healingWish && aSheet.trainer) {
    await OBR.scene.items.updateItems([aSheet.trainer], (ds) => { for (const d0 of ds) if (d0.metadata["com.pmp-fichas/trainer"]) d0.metadata["com.pmp-fichas/trainer"] = { ...d0.metadata["com.pmp-fichas/trainer"], healingWish: true }; });
    entry.notes.push("o próximo Pokémon liberado volta com a vida cheia e sem condições");
  }

  // switching and trapping moves (trainer.js): Dragon Tail, Roar, U-turn, Mean Look...
  await switchEffects(rules, { attackerItem, moveName, targetItems, entry });
  await pushLog(entry);
  if (settings.mapFx) await sendFx(attackerItem, entry, targetItems).catch(() => {});
  // Sentinela nearby: attacking someone else gives them a reaction attack
  if (running && !opts.opportunity && (move.attackBonus != null || move.saveDC != null) && targetItems.length) await checkSentinel(rules, attackerItem, targetItems).catch(() => {});
  // Counter / Mirror Coat / Metal Burst / Comeuppance / Spite: the ones it hit may answer (5 s popup)
  if (running && !opts.defense && targetItems.length) {
    const hitIds = new Set(entry.results.filter((r) => r.targetId && (r.damage?.final > 0 || r.attack?.hit)).map((r) => r.targetId));
    if (hitIds.size) {
      const { afterHitReactions } = await import("./protect.js?v=0.9.11");
      const hit = await OBR.scene.items.getItems([...hitIds]);
      await afterHitReactions(rules, (await OBR.scene.items.getItems([attackerItem.id]))[0] ?? attackerItem, move, hit).catch(() => {});
    }
  }
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
