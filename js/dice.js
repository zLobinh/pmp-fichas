// Rolls go through Dice+ (3D dice on everyone's screen) when it is in the room,
// otherwise through our own dice. Protocol: https://extensions.owlbear.rodeo/dice-plus
import { OBR, ID } from "./store.js?v=0.4.0";
import { d, rollDice } from "./rules.js?v=0.4.0";

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
    setTimeout(() => { if (pending.delete(rollId)) reject(new Error("Dice+ não respondeu")); }, 20000);
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

// The roller used by combat: d20(bonus, label) -> { nat }, damage(amount, sides, bonus, label) -> { dice, total }
export async function getRoller({ useDicePlus = true, showResults = true } = {}) {
  const viaDicePlus = useDicePlus && (await dicePlusReady());
  const internal = {
    name: "interno",
    async d20() { return { nat: d(20) }; },
    async damage(amount, sides) { const dice = rollDice(amount, sides); return { dice, total: dice.reduce((a, b) => a + b, 0) }; },
  };
  if (!viaDicePlus) return internal;
  return {
    name: "Dice+",
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
