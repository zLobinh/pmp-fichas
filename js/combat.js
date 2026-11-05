// Using a move, following the PMP rulebook:
//   1. turn/action check (Pretty Sordid) and the attacker's conditions (paralysis, confusion, charm)
//   2. ONE throw with every die: attacks (with advantage/Helping Hand), saves (with disadvantage),
//      status contests and damage
//   3. stages in to-hit/DC/AC/saves/damage, crit margin, natural 1/20 on saves, burn, type effectiveness
//   4. conditions and stage changes from the move text, written to the tokens
import { OBR, getSheet, updateSheet, pushLog, getSettings } from "./store.js?v=0.8.2";
import { TYPE_PT, ATTR_PT, signed, fmtM, d } from "./rules.js?v=0.8.2";
import { checkRange, OutOfRange, sendFx, distanceMeters } from "./map.js?v=0.8.2";
import { getRoller } from "./dice.js?v=0.8.2";
import {
  CONDITIONS, STAGES, conditionsOf, giveCondition, clearCondition, stage, addStage, moveEffects, chooseCost, spend,
  statusGate, attackAdvantage, saveAdvantage, isActive, inInitiative, PRETTY, TurnError,
  allies, teamOf, canSeeFull, ampPoints, redPoints, pointsSummary, amplifyDice, pointsText,
} from "./battle.js?v=0.8.2";
import {
  special, chargingOf, invulnOf, invulnText, invulnCheck, releaseReady, elevated, movement, jumpOpts, spendMovement,
  fall, approach, moveToken,
} from "./tactics.js?v=0.8.2";

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

  if (!releasing && typeof move.pp === "number" && move.pp <= 0) throw new Error(`${move.label} está sem PP.`);

  // invulnerable targets (Fly, Dig...): only the right moves reach them
  const blocked = [];
  if (!activating) {
    for (const t of targetItems) {
      const inv = invulnCheck(getSheet(t), moveName);
      if (inv?.blocked) blocked.push({ t, reason: inv.reason });
    }
    if (blocked.length && !opts.area) throw new Error(blocked.map((b) => `${b.t.name} está ${b.reason}: não pode ser alvo`).join("; ") + ".");
    if (blocked.length) targetItems = targetItems.filter((t) => !blocked.some((b) => b.t.id === t.id));
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
  } else {
    cost = opts.force ? null : chooseCost(attackerItem, raw, running);
    if (cost && sp?.kind === "recharge") { cost.recharge = true; cost.label += ", recarga no próximo turno"; }
    if (cost) entry.cost = cost.label;
  }

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

  const plans = targetItems.map((t) => {
    const tSheet = getSheet(t);
    const target = tSheet?.pkmn;
    const far = farFromFlier.has(t.id);
    const saveAdv = Math.max(-1, Math.min(1, (tSheet && move.save ? saveAdvantage(tSheet, move.save) : 0) + (far ? 1 : 0)));
    const saveMod = move.saveDC != null && target ? (rules.saves(target)[move.save] ?? 0) + stage(target, "Evasion") : null;
    const adv = move.attackBonus != null && tSheet ? Math.max(-1, Math.min(1, attackAdvantage(aSheet, tSheet) + (diving ? 1 : 0) - (far ? 1 : 0))) : 0;
    const inv = invulnCheck(tSheet, moveName);
    const contestMod = fx.contest && target ? mod(rules.attributes(target)[fx.contest.attr] ?? 10) : null;
    return {
      t, tSheet, target, saveMod, adv, saveAdv, inv,
      dmg2: inv?.double && hasDice ? Array.from({ length: dmg.times }, () => want({ amount: dmgAmount, sides: dmg.dice, bonus: 0 })) : null,
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
      const total = n + move.attackBonus + acc + bonus + releasePenalty;
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
    // Smack Down: an elevated Pokémon (or one in Fly/Bounce) is brought down
    if (moveName === "Smack Down" && hit && p.hitFactor > 0 && (getSheet(p.t)?.battle?.alt > 0 || p.inv?.cancel)) ch.smack = true;
  }
  // a charged move's self stages came when it was activated
  const selfStages = !releasing && fx.self.length && (move.attackBonus == null || anyHit || !targetItems.length) ? fx.self : [];

  if (!targetItems.length) {
    if (dmg) {
      const roll = hasDice ? sumDamage(sharedDmg) : { dice: [], total: dmg.bonus };
      entry.results.push({ target: null, note: `Dano: ${Math.max(0, roll.total)} (${move.damageText})`, damage: { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus, final: Math.max(0, roll.total) } });
    } else if (!selfStages.length) entry.results.push({ target: null, note: opts.area ? "Nenhum alvo na área" : "Move usado" });
  }

  // 6) write everything
  // (a charged / invulnerable move already used its PP when it was activated)
  const usesPP = !releasing && settings.autoPP && typeof move.pp === "number";
  await updateSheet(attackerItem.id, (s) => {
    if (usesPP) s.pkmn.moves[moveName].pp = Math.max(0, rules.movePP(s.pkmn, moveName) - 1);
    spend(s, cost);
    for (const st of selfStages) addStage(s.pkmn, st.stat, st.delta);
    if (pendingHelp) delete s.battle.helped; // Helping Hand is for ONE move
    if (s.battle.charging) {
      if (!releasing) entry.notes.push(`a carga de ${s.battle.charging.move} se perdeu`);
      delete s.battle.charging; // released, or lost by using another move
    }
    delete s.battle.prepared;
    if (jumped && tracked) { s.battle.move ??= { used: 0 }; s.battle.move.used = Math.round(((s.battle.move.used ?? 0) + jumped) * 10) / 10; }
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
  for (const [id, ch] of changes) {
    if (!ch.damage && !ch.give.length && !ch.stages.length && !ch.smack) continue;
    const r = entry.results.find((x) => x.targetId === id);
    const ownTurn = isActive(targetItems.find((t) => t.id === id));
    await updateSheet(id, (s) => {
      if (ch.damage) takeDamage(s.pkmn, ch.damage);
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

  await pushLog(entry);
  if (settings.mapFx) await sendFx(attackerItem, entry, targetItems).catch(() => {});
  return entry;
}

// ------------------------------------------------------------------ "Arremessar" (pág. 54)
// Standard action: throw an object (or a willing creature) as far as a long jump, without the run
// (2 m + 1 m per STR mod point). Attack d20 + STR mod vs AC, 1d6 + STR mod typeless damage.
// Ghosts are immune. Works on flying targets (the distance counts the altitude).
export const THROW = "__throw";
export const throwRange = (rules, pkmn) => 2 + Math.max(0, mod(rules.attributes(pkmn).STR));

export async function throwAttack(rules, attackerItem, target, opts = {}) {
  const settings = await getSettings();
  const aSheet = getSheet(attackerItem);
  const pkmn = aSheet.pkmn;
  const who = attackerItem.name || rules.name(pkmn);
  if (!target) throw new Error("Escolha o alvo do arremesso no mapa.");
  if (invulnOf(aSheet)) throw new TurnError(`${who} está ${invulnText(aSheet.battle.charging)}.`);
  const inv = invulnCheck(getSheet(target), "Arremessar");
  if (inv?.blocked) throw new Error(`${target.name} está ${inv.reason}: não pode ser alvo.`);
  const str = mod(rules.attributes(pkmn).STR);
  const range = throwRange(rules, pkmn);
  const rangeInfo = { kind: "ranged", meters: range, label: fmtM(range) };
  if (settings.checkRange && !opts.ignoreRange) {
    const [r] = await checkRange(attackerItem, { rangeInfo }, [target]);
    if (!r.ok) throw new OutOfRange([r]);
  }
  const running = await combatRunning();
  const cost = opts.force ? null : chooseCost(attackerItem, { "Move Time": "1 ação" }, running);
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  const tSheet = getSheet(target);
  const tp = tSheet?.pkmn;
  const adv = tSheet ? attackAdvantage(aSheet, tSheet) : 0;
  const [atk, dm] = await roller.batch([{ amount: adv ? 2 : 1, sides: 20, bonus: str }, { amount: 1, sides: 6, bonus: str }], `${who} arremessa`);
  const n = adv ? Math.max(...atk.dice) : atk.dice[0];
  const total = n + str;
  const ac = tp ? rules.ac(tp) + stage(tp, "Evasion") : null;
  const crit = n === 20;
  const hit = n !== 1 && (crit || ac == null || total >= ac);
  const ghost = !!tp && rules.types(tp).includes("Ghost");
  const dice = [...dm.dice, ...(crit ? [d(6)] : [])];
  const final = hit && !ghost ? Math.max(0, dice.reduce((a, b) => a + b, 0) + str) : 0;
  const r = {
    targetId: target.id, target: target.name || "Alvo", effects: [], team: tSheet ? teamOf(tSheet) : null, owner: tSheet?.owner ?? null,
    attack: { nat: n, total, ac, crit, hit, fumble: n === 1, adv: adv > 0 },
    damage: hit ? { dice: [dice], sides: 6, bonus: str, rolled: final, eff: ghost ? 0 : 1, effLabel: ghost ? "imune (Fantasma)" : "", final, crit } : null,
  };
  await updateSheet(attackerItem.id, (s) => { spend(s, cost); delete s.battle.prepared; });
  if (tp && final > 0 && settings.autoDamage) {
    await updateSheet(target.id, (s) => takeDamage(s.pkmn, final));
    const after = getSheet((await OBR.scene.items.getItems([target.id]))[0]);
    r.hpAfter = `${after.pkmn.hp.current}/${rules.maxHP(after.pkmn)}`;
    if (after.pkmn.hp.current <= 0) r.effects.push("DESMAIOU");
  }
  const entry = { kind: "move", attacker: who, move: "Arremessar", type: "Sem tipo", results: [r], notes: [`alcance ${fmtM(range)}`], roller: roller.name, cost: cost?.label };
  await pushLog(entry);
  if (settings.mapFx) await sendFx(attackerItem, entry, [target]).catch(() => {});
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
