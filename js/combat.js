// Using a move: attack rolls / saving throws against each target, damage with type effectiveness,
// then HP and PP changes written back to the tokens. Dice go through Dice+ when it is in the room.
import { OBR, getSheet, updatePokemon, pushLog, getSettings } from "./store.js?v=0.4.0";
import { TYPE_PT, ATTR_PT, signed } from "./rules.js?v=0.4.0";
import { checkRange, OutOfRange, sendFx } from "./map.js?v=0.4.0";
import { getRoller } from "./dice.js?v=0.4.0";

async function rollDamage(roller, dmg, crit, text) {
  const hits = [];
  for (let i = 0; i < dmg.times; i++) {
    if (!dmg.amount || !dmg.dice) { hits.push({ dice: [], total: dmg.bonus }); continue; }
    const r = await roller.damage(dmg.amount * (crit ? 2 : 1), dmg.dice, dmg.bonus, text);
    hits.push({ dice: r.dice, total: r.total + dmg.bonus });
  }
  return { hits, total: Math.max(0, hits.reduce((a, h) => a + h.total, 0)) };
}

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

  // 1) attack rolls / saves per target
  const plans = [];
  for (const t of targetItems) {
    const target = getSheet(t)?.pkmn;
    const r = { targetId: t.id, target: t.name || (target ? rules.name(target) : "Alvo") };
    let hitFactor = 1; // 1 full damage, 0.5 half (save success), 0 none
    let crit = false;

    if (move.attackBonus != null) {
      const { nat } = await roller.d20(move.attackBonus, `${moveName_} → ${r.target}`);
      const total = nat + move.attackBonus;
      const ac = target ? rules.ac(target) : null;
      crit = nat === 20;
      const hit = nat !== 1 && (crit || ac == null || total >= ac);
      r.attack = { nat, total, ac, crit, hit, fumble: nat === 1 };
      if (!hit) hitFactor = 0;
      // attack + save (e.g. Acid Spray): the save is for the secondary effect, damage is unchanged
      if (hit && move.saveDC != null) {
        const saveMod = target ? rules.saves(target)[move.save] ?? 0 : null;
        if (saveMod != null) {
          const { nat: sNat } = await roller.d20(saveMod, `${r.target} TR ${ATTR_PT[move.save] ?? move.save}`);
          r.save = { attr: ATTR_PT[move.save] ?? move.save, nat: sNat, total: sNat + saveMod, dc: move.saveDC, success: sNat + saveMod >= move.saveDC, effectOnly: true };
        } else r.save = { attr: ATTR_PT[move.save] ?? move.save, dc: move.saveDC, unknown: true, effectOnly: true };
      }
    } else if (move.saveDC != null) {
      const attr = move.save;
      const saveMod = target ? rules.saves(target)[attr] ?? 0 : null;
      if (saveMod != null) {
        const { nat } = await roller.d20(saveMod, `${r.target} TR ${ATTR_PT[attr] ?? attr} (CD ${move.saveDC})`);
        const total = nat + saveMod;
        const success = total >= move.saveDC;
        r.save = { attr: ATTR_PT[attr] ?? attr, nat, total, dc: move.saveDC, success };
        if (success) hitFactor = 0.5;
      } else {
        r.save = { attr: ATTR_PT[attr] ?? attr, dc: move.saveDC, unknown: true };
      }
    }
    plans.push({ t, target, r, hitFactor, crit });
    entry.results.push(r);
  }

  // 2) damage: one roll per target, or one roll shared by the whole area (no crits on areas)
  const damageChanges = new Map();
  let shared = null;
  if (move.damage) {
    for (const p of plans) {
      if (p.hitFactor === 0) continue;
      let roll;
      if (opts.area) roll = shared ??= await rollDamage(roller, move.damage, false, `${moveName_} (área)`);
      else roll = await rollDamage(roller, move.damage, p.crit, `${moveName_} dano${p.crit ? " CRÍTICO" : ""}`);
      const eff = p.target ? rules.effectiveness(move.type, p.target) : 1;
      let final = Math.floor(roll.total * eff);
      if (p.hitFactor === 0.5) final = Math.floor(final / 2);
      p.r.damage = { dice: roll.hits.map((h) => h.dice), sides: move.damage.dice, bonus: move.damage.bonus, rolled: roll.total, eff, effLabel: effLabel(eff), final, half: p.hitFactor === 0.5, shared: !!opts.area };
      if (p.target && settings.autoDamage) damageChanges.set(p.t.id, final);
    }
  }

  if (!targetItems.length) {
    if (move.damage) {
      const roll = await rollDamage(roller, move.damage, false, `${moveName_} dano`);
      entry.results.push({ target: null, note: `Dano: ${roll.total} (${move.damageText})`, damage: { dice: roll.hits.map((h) => h.dice), sides: move.damage.dice, bonus: move.damage.bonus, final: roll.total } });
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
