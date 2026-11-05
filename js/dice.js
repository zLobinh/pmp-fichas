// Rolls go through Dice+ (3D dice on everyone's screen) when it is in the room,
// otherwise through our own dice. Protocol: https://extensions.owlbear.rodeo/dice-plus
import { OBR, ID } from "./store.js?v=0.8.2";
import { d, rollDice } from "./rules.js?v=0.8.2";

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
export async function getRoller({ useDicePlus = true, showResults = true } = {}) {
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
    async batch(parts, text) {
      const out = parts.map(() => null);
      const thrown = parts.map((p, i) => ({ ...p, i })).filter((p) => p.amount > 0 && p.sides >= 2);
      if (thrown.length) {
        try {
          const count = new Map(); // sides -> dice, in order of first use
          for (const p of thrown) count.set(p.sides, (count.get(p.sides) ?? 0) + p.amount);
          const notation = [...count].map(([sides, n]) => `${n}d${sides}`).join(" + ") + label(text);
          const r = await dicePlusRoll(notation, showResults);
          const pool = new Map();
          for (const g of r.groups) {
            if (g.isNegative) continue;
            const sides = parseInt(String(g.diceType).replace(/\D/g, ""), 10);
            pool.set(sides, [...(pool.get(sides) ?? []), ...kept(g)]);
          }
          for (const p of thrown) {
            const dice = (pool.get(p.sides) ?? []).splice(0, p.amount);
            if (dice.length === p.amount) out[p.i] = { dice };
          }
        } catch {}
      }
      // anything Dice+ didn't give back (or d1) is rolled here
      return parts.map((p, i) => out[i] ?? { dice: rollDice(p.amount, p.sides) });
    },
    async d20(bonus, text) {
      try {
        const r = await dicePlusRoll(`1d20${withBonus(bonus)}${label(text)}`, showResults);
        const g = r.groups.find((x) => x.diceType === "d20") ?? r.groups[0];
        return { nat: kept(g)[0] };
      } catch { return internal.d20(); }
    },
    async damage(amount, sides, bonus, text) {
      if (sides < 2) return internal.damage(amount, sides); // d1 (Struggle): nothing to animate
      try {
        const r = await dicePlusRoll(`${amount}d${sides}${withBonus(bonus)}${label(text)}`, showResults);
        const dice = r.groups.filter((x) => x.diceType === `d${sides}` && !x.isNegative).flatMap(kept);
        return { dice, total: dice.reduce((a, b) => a + b, 0) };
      } catch { return internal.damage(amount, sides); }
    },
  };
}
