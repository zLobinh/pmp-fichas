// Using a move, following the PMP rulebook:
//   1. turn/action check (Pretty Sordid) and the attacker's conditions (paralysis, confusion, charm)
//   2. ONE throw with every die: attacks (with advantage/Helping Hand), saves (with disadvantage),
//      status contests and damage
//   3. stages in to-hit/DC/AC/saves/damage, crit margin, natural 1/20 on saves, burn, type effectiveness
//   4. conditions and stage changes from the move text, written to the tokens
import { OBR, getSheet, updateSheet, pushLog, getSettings } from "./store.js?v=0.7.0";
import { TYPE_PT, ATTR_PT, signed } from "./rules.js?v=0.7.0";
import { checkRange, OutOfRange, sendFx } from "./map.js?v=0.7.0";
import { getRoller } from "./dice.js?v=0.7.0";
import {
  CONDITIONS, STAGES, conditionsOf, giveCondition, clearCondition, stage, addStage, moveEffects, chooseCost, spend,
  statusGate, attackAdvantage, saveAdvantage, isActive, PRETTY, TurnError,
  allies, teamOf, canSeeFull, ampPoints, redPoints, pointsSummary, amplifyDice, pointsText,
} from "./battle.js?v=0.7.0";

export { TurnError };

const effLabel = (m) => (m === 0 ? "imune" : m >= 4 ? "super efetivo ×4" : m >= 2 ? "super efetivo ×2" : m <= 0.25 ? "pouco efetivo ×¼" : m < 1 ? "pouco efetivo ×½" : "");
const mod = (v) => Math.floor((v - 10) / 2);
const stageText = (list) => list.map((s) => `${STAGES[s.stat]} ${s.delta > 0 ? "+" : ""}${s.delta}`).join(", ");

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

  if (typeof move.pp === "number" && move.pp <= 0) throw new Error(`${move.label} está sem PP.`);
  if (settings.checkRange && !opts.ignoreRange && !opts.area && targetItems.length) {
    const out = (await checkRange(attackerItem, move, targetItems)).filter((x) => !x.ok);
    if (out.length) throw new OutOfRange(out);
  }
  // 1) whose turn is it, and which action does this spend
  const cost = opts.force ? null : chooseCost(attackerItem, raw, await combatRunning());
  if (cost) entry.cost = cost.label;

  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  entry.roller = roller.name;
  const moveName_ = move.label.replace(/ PMP$/, "");

  // conditions that can stop the attacker (paralysis d4, confusion d6, charm d4...)
  const gate = await statusGate(rules, attackerItem, roller);
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

  // Helping Hand used as a move: the bonus waits on the ally for its NEXT attack only
  if (moveName === "Helping Hand") {
    const allyTargets = targetItems.filter((t) => getSheet(t) && t.id !== attackerItem.id && allies(aSheet, getSheet(t)));
    if (!allyTargets.length) throw new Error("Helping Hand: escolha um aliado (Pokémon da mesma equipe) como alvo.");
    await updateSheet(attackerItem.id, (s) => {
      if (settings.autoPP && typeof move.pp === "number") s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - 1);
      spend(s, cost);
    });
    const round = Number((await OBR.scene.getMetadata())["com.pretty-initiative/roundCount"] ?? 0);
    for (const t of allyTargets) {
      await updateSheet(t.id, (s) => { s.battle.helped = { by: who, round }; });
      entry.results.push({ targetId: t.id, target: t.name, effects: ["🤝 Helping Hand pronto pro próximo ataque (+1d6 no acerto, mais dados de dano)"] });
    }
    await pushLog(entry);
    return entry;
  }

  // Helping Hand on this attack: chosen helpers (their reaction) and/or one waiting on the attacker.
  // +1d6 on the attack rolls; damage: +2 amplification points (1 point with a single die), pág. 57
  const helpers = opts.helpers ?? [];
  const pendingHelp = (move.attackBonus != null || move.damage) ? aSheet.battle?.helped : null;
  const helped = helpers.length > 0 || !!pendingHelp;
  if (helped) entry.notes.push(`Helping Hand de ${[...helpers.map((h) => h.name), ...(pendingHelp ? [pendingHelp.by] : [])].join(", ")}`);

  // modifiers from the attacker's stages
  const acc = stage(attacker, "Accuracy");
  const critMargin = 3 * stage(attacker, "CritMargin");
  const critAt = Math.max(2, 20 - critMargin);
  const atkStageKey = melee ? "Attack" : "SpecialAttack";
  const burned = !!conditionsOf(aSheet).Burning;
  const dc = move.saveDC != null ? move.saveDC + acc : null;

  // 2) every die of the move in ONE throw
  const dmg = move.damage;
  const hasDice = dmg && dmg.amount && dmg.dice;
  // Pontos de Amplificação/Redução (the app's "Mudanças de Status" screen + Helping Hand)
  const aProfHalf = Math.max(1, Math.floor(rules.proficiency(attacker) / 2));
  const amp = ampPoints(attacker) + (helped && hasDice ? (dmg.amount > 1 ? 2 : 1) : 0);
  const pts = pointsSummary(amp, redPoints(attacker));
  const amped = hasDice ? amplifyDice(dmg.amount, dmg.dice, pts.ampGroups) : { amount: 0, bonus: 0 };
  const dmgAmount = amped.amount;
  const flatPts = amped.bonus + (pts.ampFlat ? aProfHalf : 0) - (pts.redFlat ? aProfHalf : 0);
  const reroll = pts.ampReroll && !pts.redReroll ? 1 : pts.redReroll && !pts.ampReroll ? -1 : 0; // 2x keep higher / lower
  if (amp || redPoints(attacker)) entry.notes.push(`pontos de dano: ${pointsText(amp, redPoints(attacker), dmg?.amount || 1, dmg?.dice || 8) || "—"}`);
  const parts = [];
  const want = (p) => parts.push(p) - 1;
  const dmgParts = () => Array.from({ length: dmg.times }, () => [want({ amount: dmgAmount, sides: dmg.dice, bonus: dmg.bonus }), reroll ? want({ amount: dmgAmount, sides: dmg.dice, bonus: 0 }) : null]);
  const plans = targetItems.map((t) => {
    const tSheet = getSheet(t);
    const target = tSheet?.pkmn;
    const saveAdv = tSheet && move.save ? saveAdvantage(tSheet, move.save) : 0;
    const saveMod = move.saveDC != null && target ? (rules.saves(target)[move.save] ?? 0) + stage(target, "Evasion") : null;
    const adv = move.attackBonus != null && tSheet ? attackAdvantage(aSheet, tSheet) : 0;
    const contestMod = fx.contest && target ? mod(rules.attributes(target)[fx.contest.attr] ?? 10) : null;
    return {
      t, tSheet, target, saveMod, adv, saveAdv,
      // team/owner travel with the result so each viewer can hide what they shouldn't see
      r: { targetId: t.id, target: t.name || (target ? rules.name(target) : "Alvo"), effects: [], team: tSheet ? teamOf(tSheet) : null, owner: tSheet?.owner ?? null },
      atk: move.attackBonus != null ? want({ amount: adv ? 2 : 1, sides: 20, bonus: move.attackBonus }) : null,
      help: helped && move.attackBonus != null ? want({ amount: 1, sides: 6, bonus: 0 }) : null,
      sav: saveMod != null ? want({ amount: saveAdv ? 2 : 1, sides: 20, bonus: saveMod }) : null,
      con: fx.contest && (fx.contest.status || fx.contest.stages.length) ? want({ amount: 1, sides: 20, bonus: 0 }) : null,
      contestMod,
      dmg: hasDice && !opts.area ? dmgParts() : null,
    };
  });
  const sharedDmg = hasDice && (opts.area || !targetItems.length) ? dmgParts() : null;
  const rolled = parts.length ? await roller.batch(parts, `${moveName_}${opts.area ? " (área)" : ""}`) : [];
  const dice = (i) => rolled[i].dice;
  const pick = (i, adv) => (adv > 0 ? Math.max(...dice(i)) : adv < 0 ? Math.min(...dice(i)) : dice(i)[0]);
  // one hit: the dice (or the better/worse of two rolls when there are rerolling points)
  const sumHit = ([main, second]) => {
    const a = dice(main).reduce((x, y) => x + y, 0);
    if (second == null) return { dice: dice(main), total: a };
    const b = dice(second).reduce((x, y) => x + y, 0);
    const useB = reroll > 0 ? b > a : b < a;
    return useB ? { dice: dice(second), total: b } : { dice: dice(main), total: a };
  };
  const sumDamage = (list) => {
    const hits = list.map(sumHit);
    return { dice: hits.map((h) => h.dice), total: hits.reduce((a, h) => a + h.total + dmg.bonus + flatPts, 0) };
  };

  // 3) attacks, saves and contests
  let anyHit = false;
  for (const p of plans) {
    const { r, target } = p;
    p.hitFactor = 1;
    p.crit = false;
    if (p.atk != null) {
      const n = pick(p.atk, p.adv);
      const bonus = p.help != null ? dice(p.help)[0] : 0;
      const total = n + move.attackBonus + acc + bonus;
      const ac = target ? rules.ac(target) + stage(target, "Evasion") : null;
      p.crit = n >= critAt;
      const hit = n !== 1 && (p.crit || ac == null || total >= ac);
      r.attack = { nat: n, total, ac, crit: p.crit, hit, fumble: n === 1, adv: p.adv > 0, help: bonus || null };
      if (!hit) p.hitFactor = 0;
    }
    if (dc != null && (p.atk == null || r.attack.hit)) {
      const attr = ATTR_PT[move.save] ?? move.save;
      const effectOnly = p.atk != null; // attack + save (e.g. Acid Spray): the save is for the secondary effect
      if (p.sav != null) {
        const n = pick(p.sav, p.saveAdv);
        // natural 20 always passes (and takes no damage), natural 1 always fails (and is a critical hit)
        const success = n === 20 || (n !== 1 && n + p.saveMod >= dc);
        r.save = { attr, nat: n, total: n + p.saveMod, dc, success, effectOnly, dis: p.saveAdv < 0 };
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
  const critRolls = crits.length ? await roller.batch(crits.flatMap((p) => p.dmg.map(() => ({ amount: dmgAmount, sides: dmg.dice, bonus: 0 }))), `${moveName_} CRÍTICO`) : [];

  // 4) damage: stages, burn, type, defense
  const changes = new Map(); // targetId -> { damage, give: [], stages: [], wake, thaw }
  const change = (id) => { if (!changes.has(id)) changes.set(id, { damage: 0, give: [], stages: [] }); return changes.get(id); };
  if (dmg) {
    let c = 0;
    const aProf = rules.proficiency(attacker);
    for (const p of plans) {
      if (p.hitFactor === 0) continue;
      let roll = !hasDice ? { dice: [], total: dmg.bonus * dmg.times } : sumDamage(p.dmg ?? sharedDmg);
      if (p.crit && p.dmg) {
        const extra = p.dmg.map(() => critRolls[c++].dice);
        roll = { dice: roll.dice.map((d0, i) => [...d0, ...extra[i]]), total: roll.total + extra.flat().reduce((a, b) => a + b, 0) };
      }
      // Ataque/Ataque Especial: + stage x proficiency (a crit ignores the attacker's negative stages)
      let atkStage = stage(attacker, atkStageKey);
      if (p.crit && atkStage < 0) atkStage = 0;
      let total = roll.total + atkStage * aProf;
      if (burned && melee) total = Math.floor(total / 2); // Queimado: melee damage halved
      const eff = p.target ? rules.effectiveness(move.type, p.target) : 1;
      let final = Math.floor(Math.max(0, total) * eff);
      // Defesa/Defesa Especial of the target: - stage x ITS proficiency (a crit ignores positive stages)
      if (p.target && eff > 0) {
        let defStage = stage(p.target, melee ? "Defense" : "SpecialDefense");
        if (p.crit && defStage > 0) defStage = 0;
        final = Math.max(0, final - defStage * rules.proficiency(p.target));
      }
      if (p.hitFactor === 0.5) final = Math.floor(final / 2);
      // Redução: each 2 points halve the final damage (rounded down each time)
      for (let i = 0; i < pts.redHalvings; i++) final = Math.floor(final / 2);
      p.r.damage = { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus + flatPts + atkStage * aProf, rolled: total, eff, effLabel: effLabel(eff), final, half: p.hitFactor === 0.5, shared: !!opts.area, crit: p.crit };
      if (p.target && settings.autoDamage && final > 0) {
        const ch = change(p.t.id);
        ch.damage += final;
        if (p.crit) ch.wake = true; // a critical hit wakes up / removes Sonolento
        if (move.type === "Fire") ch.thaw = true; // fire damage thaws
      }
    }
  }

  // 5) effects from the move text
  for (const p of plans) {
    if (!p.target) continue;
    const ch = change(p.t.id);
    const hit = p.atk == null || p.r.attack.hit;
    const failed = p.r.save && !p.r.save.unknown && !p.r.save.success;
    if (fx.natural && p.r.attack?.hit && p.r.attack.nat >= fx.natural.min) {
      if (fx.natural.status) ch.give.push(fx.natural.status);
      ch.stages.push(...fx.natural.stages);
    }
    if (failed) { if (fx.statusFail) ch.give.push(fx.statusFail); ch.stages.push(...fx.fail); }
    if (hit && fx.direct.length && (dmg ? p.hitFactor > 0 : !move.save)) ch.stages.push(...fx.direct);
    if (p.r.contest?.success) { if (fx.contest.status) ch.give.push(fx.contest.status); ch.stages.push(...fx.contest.stages); }
    if (fx.statusDirect && hit && !move.save) ch.give.push(fx.statusDirect);
  }
  const selfStages = fx.self.length && (move.attackBonus == null || anyHit || !targetItems.length) ? fx.self : [];

  if (!targetItems.length) {
    if (dmg) {
      const roll = hasDice ? sumDamage(sharedDmg) : { dice: [], total: dmg.bonus };
      entry.results.push({ target: null, note: `Dano: ${Math.max(0, roll.total)} (${move.damageText})`, damage: { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus, final: Math.max(0, roll.total) } });
    } else if (!selfStages.length) entry.results.push({ target: null, note: opts.area ? "Nenhum alvo na área" : "Move usado" });
  }

  // 6) write everything
  await updateSheet(attackerItem.id, (s) => {
    if (settings.autoPP && typeof move.pp === "number") s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - 1);
    spend(s, cost);
    for (const st of selfStages) addStage(s.pkmn, st.stat, st.delta);
    if (pendingHelp) delete s.battle.helped; // Helping Hand is for ONE move
  });
  if (settings.autoPP && typeof move.pp === "number") entry.pp = `${move.pp - 1}/${move.ppMax}`;
  if (selfStages.length) entry.notes.push(`${who}: ${stageText(selfStages)}`);
  for (const h of helpers) {
    await updateSheet(h.id, (s) => {
      s.battle.econ = { action: true, bonus: true, ...(s.battle.econ ?? {}), reaction: false };
      if (settings.autoPP && typeof rules.movePP(s.pkmn, "Helping Hand") === "number") s.pkmn.moves["Helping Hand"].pp = Math.max(0, rules.movePP(s.pkmn, "Helping Hand") - 1);
    });
  }
  for (const [id, ch] of changes) {
    if (!ch.damage && !ch.give.length && !ch.stages.length) continue;
    const r = entry.results.find((x) => x.targetId === id);
    const ownTurn = isActive(targetItems.find((t) => t.id === id));
    await updateSheet(id, (s) => {
      if (ch.damage) takeDamage(s.pkmn, ch.damage);
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

  await pushLog(entry);
  if (settings.mapFx) await sendFx(attackerItem, entry, targetItems).catch(() => {});
  return entry;
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
    if (r.attack) s += r.attack.crit ? "CRÍTICO! " : r.attack.hit ? `acertou (${r.attack.total}${vsAC(r.attack.ac)}) ` : r.attack.fumble ? "errou (1 natural) " : `errou (${r.attack.total}${vsAC(r.attack.ac)}) `;
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
