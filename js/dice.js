// Rolls go through Dice+ (3D dice on everyone's screen) when it is in the room,
// otherwise through our own dice. Protocol: https://extensions.owlbear.rodeo/dice-plus
import { OBR, ID } from "./store.js?v=0.9.13";
import { d, rollDice } from "./rules.js?v=0.9.13";

const SOURCE = ID; // results come back on `${SOURCE}/roll-result`
const pending = new Map();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  OBR.broadcast.onMessage(`${SOURCE}/roll-result`, ({ data }) => {
    const p = pending.get(data?.rollId);
    if (!p) return;
    pending.delete(data.rollId);
    p.resolve(data.result);
  });
  OBR.broadcast.onMessage(`${SOURCE}/roll-error`, ({ data }) => {
    const p = pending.get(data?.rollId);
    if (!p) return;
    pending.delete(data.rollId);
    p.reject(new Error(`Dice+: ${data.error}`));
  });
}

let readyPromise = null;
// Dice+ answers isReady on the same channel; no answer in 1s = not installed
export function dicePlusReady() {
  readyPromise ??= new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { off(); resolve(false); }, 1000);
    const off = OBR.broadcast.onMessage("dice-plus/isReady", ({ data }) => {
      if (data?.requestId === requestId && data.ready === true) { clearTimeout(timer); off(); resolve(true); }
    });
    OBR.broadcast.sendMessage("dice-plus/isReady", { requestId, timestamp: Date.now() }, { destination: "ALL" }).catch(() => resolve(false));
  });
  return readyPromise;
}

async function dicePlusRoll(notation, showResults) {
  listen();
  const rollId = crypto.randomUUID();
  const result = new Promise((resolve, reject) => {
    pending.set(rollId, { resolve, reject });
    setTimeout(() => { if (pending.delete(rollId)) reject(new Error("Dice+ não respondeu")); }, 12000);
  });
  await OBR.broadcast.sendMessage("dice-plus/roll-request", {
    rollId,
    playerId: OBR.player.id,
    playerName: await OBR.player.getName(),
    rollTarget: "everyone",
    diceNotation: notation,
    showResults,
    timestamp: Date.now(),
    source: SOURCE,
  }, { destination: "ALL" });
  return result;
}

const label = (text) => (text ? ` # ${String(text).replace(/[#,]/g, " ").slice(0, 60)}` : "");
const withBonus = (bonus) => (bonus ? (bonus > 0 ? `+${bonus}` : `${bonus}`) : "");
const kept = (group) => group.dice.filter((x) => x.kept !== false).map((x) => x.value);

// The roller used by combat:
//   d20(bonus, label) -> { nat }
//   damage(amount, sides, bonus, label) -> { dice, total }
//   batch([{ amount, sides, bonus }], label) -> [{ dice }]  everything in ONE throw (one Dice+ animation)
// names of the Dice+ dice used for each kind of roll (colors are set on the dice in the Dice+ bag);
// null = plain dice. Set from the settings (getRoller's diceNames).
let diceNames = null;
export async function getRoller({ useDicePlus = true, showResults = true, names = undefined } = {}) {
  if (names !== undefined) diceNames = names;
  else {
    try {
      const { getSettings } = await import("./store.js?v=0.9.13");
      const s = await getSettings();
      diceNames = s.coloredDice ? { hit: s.diceHit || "Acerto", dmg: s.diceDmg || "Dano", extra: s.diceExtra || "Extra" } : null;
    } catch { diceNames = null; }
  }
  const viaDicePlus = useDicePlus && (await dicePlusReady());
  const internal = {
    name: "interno",
    async d20() { return { nat: d(20) }; },
    async damage(amount, sides) { const dice = rollDice(amount, sides); return { dice, total: dice.reduce((a, b) => a + b, 0) }; },
    async batch(parts) { return parts.map((p) => ({ dice: rollDice(p.amount, p.sides) })); },
  };
  if (!viaDicePlus) return internal;
  return {
    name: "Dice+",
    // ONE expression with every die of the move, e.g. "3d20 + 3d10 # Hyper Voice": Dice+ throws all of
    // them together (a comma list would be animated roll after roll). The dice come back by type and
    // are handed out to the parts in order; bonuses are added by the caller, not by Dice+.
    // part.tag: "hit" | "extra" | "dmg" -> the named dice of the Dice+ bag (colors), e.g.
    // "1d20{Acerto} + 1d20{Extra} + 3d8{Dano}"; a name the bag doesn't have = the normal dice
    async batch(parts, text) {
      const out = parts.map(() => null);
      const thrown = parts.map((p, i) => ({ ...p, i })).filter((p) => p.amount > 0 && p.sides >= 2);
      if (thrown.length) {
        try {
          const names = diceNames ?? {};
          const nameOf = (tag) => (tag && names[tag] ? names[tag] : "");
          const terms = new Map(); // "sides|name" -> { sides, name, n }, in order of first use
          for (const p of thrown) {
            const key = `${p.sides}|${nameOf(p.tag)}`;
            const t = terms.get(key) ?? { sides: p.sides, name: nameOf(p.tag), n: 0 };
            t.n += p.amount;
            terms.set(key, t);
          }
          const list = [...terms.values()];
          const notation = list.map((t) => `${t.n}d${t.sides}${t.name ? `{${t.name}}` : ""}`).join(" + ") + label(text);
          const r = await dicePlusRoll(notation, showResults);
          const groups = r.groups.filter((g) => !g.isNegative);
          // the groups come back in the order of the terms; by dice type when they don't line up
          const pools = new Map();
          const bySides = new Map();
          for (const g of groups) {
            const sides = parseInt(String(g.diceType).replace(/\D/g, ""), 10);
            bySides.set(sides, [...(bySides.get(sides) ?? []), ...kept(g)]);
          }
          if (groups.length === list.length && groups.every((g, i) => parseInt(String(g.diceType).replace(/\D/g, ""), 10) === list[i].sides)) {
            list.forEach((t, i) => pools.set(`${t.sides}|${t.name}`, kept(groups[i])));
          }
          for (const p of thrown) {
            const key = `${p.sides}|${nameOf(p.tag)}`;
            const src = pools.get(key) ?? bySides.get(p.sides) ?? [];
            const dice = src.splice(0, p.amount);
            if (dice.length === p.amount) out[p.i] = { dice };
          }
        } catch {}
      }
      // anything Dice+ didn't give back (or d1) is rolled here
      return parts.map((p, i) => out[i] ?? { dice: rollDice(p.amount, p.sides) });
    },
    async d20(bonus, text) {
      try {
        const r = await dicePlusRoll(`1d20${diceNames?.hit ? `{${diceNames.hit}}` : ""}${withBonus(bonus)}${label(text)}`, showResults);
        const g = r.groups.find((x) => x.diceType === "d20") ?? r.groups[0];
        return { nat: kept(g)[0] };
      } catch { return internal.d20(); }
    },
    async damage(amount, sides, bonus, text) {
      if (sides < 2) return internal.damage(amount, sides); // d1 (Struggle): nothing to animate
      try {
        const r = await dicePlusRoll(`${amount}d${sides}${diceNames?.dmg ? `{${diceNames.dmg}}` : ""}${withBonus(bonus)}${label(text)}`, showResults);
        const dice = r.groups.filter((x) => x.diceType === `d${sides}` && !x.isNegative).flatMap(kept);
        return { dice, total: dice.reduce((a, b) => a + b, 0) };
      } catch { return internal.damage(amount, sides); }
    },
  };
}
