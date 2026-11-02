// Using a move: attack rolls / saving throws against each target, damage with type effectiveness,
// then HP and PP changes written back to the tokens. Dice go through Dice+ when it is in the room.
import { OBR, getSheet, updatePokemon, pushLog, getSettings } from "./store.js?v=0.5.0";
import { TYPE_PT, ATTR_PT, signed } from "./rules.js?v=0.5.0";
import { checkRange, OutOfRange, sendFx } from "./map.js?v=0.5.0";
import { getRoller } from "./dice.js?v=0.5.0";

const effLabel = (m) => (m === 0 ? "imune" : m >= 4 ? "super efetivo ×4" : m >= 2 ? "super efetivo ×2" : m <= 0.25 ? "pouco efetivo ×¼" : m < 1 ? "pouco efetivo ×½" : "");

// applies damage to a Pokémon JSON: temp HP first, never below 0
function takeDamage(pkmn, amount) {
  const temp = pkmn.hp.temp ?? 0;
  const fromTemp = Math.min(temp, amount);
  pkmn.hp.temp = temp - fromTemp;
  pkmn.hp.current = Math.max(0, pkmn.hp.current - (amount - fromTemp));
}

// opts.ignoreRange: roll even with targets out of range (the player confirmed)
// opts.area: the targets came from an area template (no range check, damage rolled once for everyone)
export async function useMove(rules, attackerItem, moveName, targetItems, opts = {}) {
  const settings = await getSettings();
  const attacker = getSheet(attackerItem).pkmn;
  const move = rules.moveData(attacker, moveName);
  const who = attackerItem.name || rules.name(attacker);
  const entry = {
    kind: "move",
    attacker: who,
    move: move.label,
    type: TYPE_PT[move.type] ?? move.type,
    area: opts.area ? move.rangeInfo.label : null,
    results: [],
  };

  if (typeof move.pp === "number" && move.pp <= 0) throw new Error(`${move.label} está sem PP.`);
  if (settings.checkRange && !opts.ignoreRange && !opts.area && targetItems.length) {
    const out = (await checkRange(attackerItem, move, targetItems)).filter((x) => !x.ok);
    if (out.length) throw new OutOfRange(out);
  }

  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  entry.roller = roller.name;
  const moveName_ = move.label.replace(/ PMP$/, "");

  // 1) every die the move can need goes into ONE throw: attack d20s, the targets' saves, and the
  //    damage (per target, or once for the whole area). Rolls that end up unused (damage of a
  //    miss) are simply ignored.
  const dmg = move.damage;
  const hasDice = dmg && dmg.amount && dmg.dice;
  const parts = [];
  const want = (p) => parts.push(p) - 1;
  const plans = targetItems.map((t) => {
    const target = getSheet(t)?.pkmn;
    const saveMod = move.saveDC != null && target ? rules.saves(target)[move.save] ?? 0 : null;
    return {
      t, target, saveMod,
      r: { targetId: t.id, target: t.name || (target ? rules.name(target) : "Alvo") },
      atk: move.attackBonus != null ? want({ amount: 1, sides: 20, bonus: move.attackBonus }) : null,
      sav: saveMod != null ? want({ amount: 1, sides: 20, bonus: saveMod }) : null,
      dmg: hasDice && !opts.area ? Array.from({ length: dmg.times }, () => want({ amount: dmg.amount, sides: dmg.dice, bonus: dmg.bonus })) : null,
    };
  });
  const sharedDmg = hasDice && (opts.area || !targetItems.length) ? Array.from({ length: dmg.times }, () => want({ amount: dmg.amount, sides: dmg.dice, bonus: dmg.bonus })) : null;
  const rolled = parts.length ? await roller.batch(parts, `${moveName_}${opts.area ? " (área)" : ""}`) : [];
  const nat = (i) => rolled[i].dice[0];
  const sum = (idx) => ({ dice: idx.map((i) => rolled[i].dice), total: idx.reduce((a, i) => a + rolled[i].dice.reduce((x, y) => x + y, 0) + dmg.bonus, 0) });

  // 2) attack / save results
  for (const p of plans) {
    const { r, target } = p;
    p.hitFactor = 1; // 1 full damage, 0.5 half (save success), 0 none
    p.crit = false;
    if (p.atk != null) {
      const n = nat(p.atk);
      const total = n + move.attackBonus;
      const ac = target ? rules.ac(target) : null;
      p.crit = n === 20;
      const hit = n !== 1 && (p.crit || ac == null || total >= ac);
      r.attack = { nat: n, total, ac, crit: p.crit, hit, fumble: n === 1 };
      if (!hit) p.hitFactor = 0;
    }
    if (move.saveDC != null && (p.atk == null || r.attack.hit)) {
      const attr = ATTR_PT[move.save] ?? move.save;
      const effectOnly = p.atk != null; // attack + save (e.g. Acid Spray): the save is for the secondary effect
      if (p.sav != null) {
        const n = nat(p.sav);
        const success = n + p.saveMod >= move.saveDC;
        r.save = { attr, nat: n, total: n + p.saveMod, dc: move.saveDC, success, effectOnly };
        if (success && !effectOnly) p.hitFactor = 0.5;
      } else r.save = { attr, dc: move.saveDC, unknown: true, effectOnly };
    }
    entry.results.push(r);
  }

  // 3) critical hits roll only their extra dice, in a second (small) throw
  const crits = plans.filter((p) => p.crit && p.dmg);
  const critRolls = crits.length ? await roller.batch(crits.flatMap((p) => p.dmg.map(() => ({ amount: dmg.amount, sides: dmg.dice, bonus: 0 }))), `${moveName_} CRÍTICO`) : [];

  // 4) damage with type effectiveness
  const damageChanges = new Map();
  if (dmg) {
    let c = 0;
    for (const p of plans) {
      if (p.hitFactor === 0) continue;
      let roll = !hasDice ? { dice: [], total: dmg.bonus * dmg.times } : sum(p.dmg ?? sharedDmg);
      if (p.crit && p.dmg) {
        const extra = p.dmg.map(() => critRolls[c++].dice);
        roll = { dice: roll.dice.map((d0, i) => [...d0, ...extra[i]]), total: roll.total + extra.flat().reduce((a, b) => a + b, 0) };
      }
      const eff = p.target ? rules.effectiveness(move.type, p.target) : 1;
      let final = Math.floor(Math.max(0, roll.total) * eff);
      if (p.hitFactor === 0.5) final = Math.floor(final / 2);
      p.r.damage = { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus, rolled: roll.total, eff, effLabel: effLabel(eff), final, half: p.hitFactor === 0.5, shared: !!opts.area };
      if (p.target && settings.autoDamage) damageChanges.set(p.t.id, final);
    }
  }

  if (!targetItems.length) {
    if (dmg) {
      const roll = hasDice ? sum(sharedDmg) : { dice: [], total: dmg.bonus };
      entry.results.push({ target: null, note: `Dano: ${Math.max(0, roll.total)} (${move.damageText})`, damage: { dice: roll.dice, sides: dmg.dice, bonus: dmg.bonus, final: Math.max(0, roll.total) } });
    } else entry.results.push({ target: null, note: opts.area ? "Nenhum alvo na área" : "Move usado" });
  }

  if (settings.autoPP && typeof move.pp === "number") {
    await updatePokemon(attackerItem.id, (p) => {
      p.moves[moveName].pp = Math.max(0, rules.movePP(p, moveName) - 1);
    });
    entry.pp = `${move.pp - 1}/${move.ppMax}`;
  }
  for (const [id, amount] of damageChanges) {
    await updatePokemon(id, (p) => takeDamage(p, amount));
    const after = getSheet((await OBR.scene.items.getItems([id]))[0])?.pkmn;
    const r = entry.results.find((x) => x.targetId === id);
    if (after && r) r.hpAfter = `${after.hp.current}/${rules.maxHP(after)}`;
  }

  await pushLog(entry);
  if (settings.mapFx) await sendFx(attackerItem, entry, targetItems).catch(() => {});
  return entry;
}

// one-line text of a result, for notifications and the log
export function describe(entry) {
  if (entry.kind === "check") return `${entry.attacker}: ${entry.label} ${entry.total} (d20 ${entry.nat}${signed(entry.bonus)})`;
  if (entry.kind === "note") return `${entry.attacker}: ${entry.text}`;
  const parts = entry.results.map((r) => {
    if (!r.target) return r.note;
    let s = r.target + ": ";
    if (r.attack) s += r.attack.crit ? "CRÍTICO! " : r.attack.hit ? `acertou (${r.attack.total}${r.attack.ac != null ? ` vs CA ${r.attack.ac}` : ""}) ` : r.attack.fumble ? "errou (1 natural) " : `errou (${r.attack.total} vs CA ${r.attack.ac}) `;
    if (r.save) s += (r.save.effectOnly ? "efeito: " : "") + (r.save.unknown ? `TR ${r.save.attr} CD ${r.save.dc} ` : `TR ${r.save.attr} ${r.save.total} vs CD ${r.save.dc} ${r.save.success ? "(passou) " : "(falhou) "}`);
    if (r.damage) s += `${r.damage.final} de dano${r.damage.effLabel ? ` (${r.damage.effLabel})` : ""}${r.damage.half ? " (metade)" : ""}`;
    if (r.hpAfter) s += ` → HP ${r.hpAfter}`;
    return s.trim();
  });
  return `${entry.attacker} usou ${entry.move}${entry.area ? ` (${entry.area})` : ""}. ${parts.join(" | ")}`;
}
