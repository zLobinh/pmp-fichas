// Using a move: attack rolls / saving throws against each target, damage with type effectiveness,
// then HP and PP changes written back to the tokens.
import { OBR, getSheet, updatePokemon, pushLog, getSettings } from "./store.js";
import { d, rollDice, TYPE_PT, ATTR_PT, signed } from "./rules.js";

function rollDamage(dmg, crit) {
  const hits = [];
  for (let i = 0; i < dmg.times; i++) {
    const dice = dmg.amount && dmg.dice ? rollDice(dmg.amount * (crit ? 2 : 1), dmg.dice) : [];
    hits.push({ dice, total: dice.reduce((a, b) => a + b, 0) + dmg.bonus });
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

export async function useMove(rules, attackerItem, moveName, targetItems) {
  const settings = await getSettings();
  const attacker = getSheet(attackerItem).pkmn;
  const move = rules.moveData(attacker, moveName);
  const entry = {
    kind: "move",
    attacker: attackerItem.name || rules.name(attacker),
    move: move.label,
    type: TYPE_PT[move.type] ?? move.type,
    results: [],
  };

  if (typeof move.pp === "number" && move.pp <= 0) throw new Error(`${move.label} está sem PP.`);

  const damageChanges = new Map();
  for (const t of targetItems) {
    const tSheet = getSheet(t);
    const target = tSheet?.pkmn;
    const r = { targetId: t.id, target: t.name || (target ? rules.name(target) : "Alvo") };
    let hitFactor = 1; // 1 full damage, 0.5 half (save success), 0 none
    let crit = false;

    if (move.attackBonus != null) {
      const nat = d(20);
      const total = nat + move.attackBonus;
      const ac = target ? rules.ac(target) : null;
      crit = nat === 20;
      const hit = nat !== 1 && (crit || ac == null || total >= ac);
      r.attack = { nat, total, ac, crit, hit, fumble: nat === 1 };
      if (!hit) hitFactor = 0;
      // attack + save (e.g. Acid Spray): the save is for the secondary effect, damage is unchanged
      if (hit && move.saveDC != null) {
        const saveMod = target ? rules.saves(target)[move.save] ?? 0 : null;
        const sNat = saveMod != null ? d(20) : null;
        r.save = saveMod != null
          ? { attr: ATTR_PT[move.save] ?? move.save, nat: sNat, total: sNat + saveMod, dc: move.saveDC, success: sNat + saveMod >= move.saveDC, effectOnly: true }
          : { attr: ATTR_PT[move.save] ?? move.save, dc: move.saveDC, unknown: true, effectOnly: true };
      }
    } else if (move.saveDC != null) {
      const attr = move.save;
      const saveMod = target ? rules.saves(target)[attr] ?? 0 : null;
      if (saveMod != null) {
        const nat = d(20);
        const total = nat + saveMod;
        const success = total >= move.saveDC;
        r.save = { attr: ATTR_PT[attr] ?? attr, nat, total, dc: move.saveDC, success };
        if (success) hitFactor = 0.5;
      } else {
        r.save = { attr: ATTR_PT[attr] ?? attr, dc: move.saveDC, unknown: true };
      }
    }

    if (move.damage && hitFactor > 0) {
      const roll = rollDamage(move.damage, crit);
      const eff = target ? rules.effectiveness(move.type, target) : 1;
      let final = Math.floor(roll.total * eff);
      if (hitFactor === 0.5) final = Math.floor(final / 2);
      r.damage = { dice: roll.hits.map((h) => h.dice), rolled: roll.total, eff, effLabel: effLabel(eff), final, half: hitFactor === 0.5 };
      if (target && settings.autoDamage) damageChanges.set(t.id, final);
    }
    entry.results.push(r);
  }

  if (!targetItems.length) entry.results.push({ target: null, note: move.damage ? `Dano: ${move.damageText}` : "Move usado" });

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
  return `${entry.attacker} usou ${entry.move}. ${parts.join(" | ")}`;
}
