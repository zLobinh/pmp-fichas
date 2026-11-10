// The battlefield: weather, terrain and the effects that sit on a side of the field (screens,
// Safeguard, Mist, Tailwind) or on the whole field (Trick Room). Kept in the scene metadata so every
// browser reads the same thing; durations count in Pretty Sordid rounds ("5 rodadas").
//
// The book centres weather and terrain on the user (15 m / 12 m); the extension treats them as
// covering the whole fight, which is how they are used at the table almost always.
import { OBR, SHEET_KEY } from "./store.js?v=0.9.8";

export const FIELD_KEY = "com.pmp-fichas/field";
const ROUND_KEY = "com.pretty-initiative/roundCount";

export const WEATHER = {
  rain: { label: "Chuva", icon: "🌧️" },
  sun: { label: "Luz solar intensa", icon: "☀️" },
  sand: { label: "Tempestade de areia", icon: "🌪️" },
  hail: { label: "Granizo", icon: "🌨️" },
  snow: { label: "Neve", icon: "❄️" },
};
export const TERRAIN = {
  electric: { label: "Electric Terrain", type: "Electric", icon: "⚡" },
  grassy: { label: "Grassy Terrain", type: "Grass", icon: "🌿" },
  misty: { label: "Misty Terrain", type: "Fairy", icon: "🌫️" },
  psychic: { label: "Psychic Terrain", type: "Psychic", icon: "🔮" },
};
// effects on one side (team); "half" = the screens' damage halving
export const SIDE = {
  reflect: { label: "Reflect", icon: "🟦" },
  lightScreen: { label: "Light Screen", icon: "🟨" },
  auroraVeil: { label: "Aurora Veil", icon: "🌈" },
  safeguard: { label: "Safeguard", icon: "🛡️" },
  mist: { label: "Mist", icon: "💨" },
  tailwind: { label: "Tailwind", icon: "🍃" },
};

// moves that start these (and how many rounds they last)
export const FIELD_MOVES = {
  "Rain Dance": { weather: "rain", rounds: 5 }, "Sunny Day": { weather: "sun", rounds: 5 },
  Sandstorm: { weather: "sand", rounds: 5 }, Hail: { weather: "hail", rounds: 5 }, Snowscape: { weather: "snow", rounds: 5 },
  "Chilly Reception": { weather: "snow", rounds: 5 },
  "Electric Terrain": { terrain: "electric", rounds: 5 }, "Grassy Terrain": { terrain: "grassy", rounds: 5 },
  "Misty Terrain": { terrain: "misty", rounds: 5 }, "Psychic Terrain": { terrain: "psychic", rounds: 5 },
  Reflect: { side: "reflect", rounds: 5 }, "Light Screen": { side: "lightScreen", rounds: 5 },
  "Aurora Veil": { side: "auroraVeil", rounds: 5, needs: ["hail", "snow"] },
  Safeguard: { side: "safeguard", rounds: 5 }, Mist: { side: "mist", rounds: 5 }, Tailwind: { side: "tailwind", rounds: 4 },
  "Trick Room": { trickRoom: true, rounds: 5 },
};
// abilities that set the weather/terrain when the Pokémon comes in
export const FIELD_ABILITIES = {
  Drizzle: { weather: "rain" }, Drought: { weather: "sun" }, "Orichalcum Pulse": { weather: "sun" },
  "Sand Stream": { weather: "sand" }, "Snow Warning": { weather: "hail" },
  "Electric Surge": { terrain: "electric" }, "Hadron Engine": { terrain: "electric" }, "Grassy Surge": { terrain: "grassy" },
  "Misty Surge": { terrain: "misty" }, "Psychic Surge": { terrain: "psychic" },
};

export const roundNow = async () => Number((await OBR.scene.getMetadata())[ROUND_KEY] ?? 1);

// a copy kept in memory for the code that can't wait (movement): updated on every scene change
let cache = { f: {}, round: 1 };
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  try {
    OBR.scene.onMetadataChange((m) => { cache = { f: m[FIELD_KEY] ?? {}, round: Number(m[ROUND_KEY] ?? 1) }; });
    OBR.scene.getMetadata().then((m) => { cache = { f: m[FIELD_KEY] ?? {}, round: Number(m[ROUND_KEY] ?? 1) }; }).catch(() => {});
  } catch { hooked = false; }
}
export function fieldCached() {
  hook();
  const { f, round } = cache;
  const sides = {};
  for (const [team, eff] of Object.entries(f.sides ?? {})) { sides[team] = {}; for (const [k, e] of Object.entries(eff)) if (live(e, round)) sides[team][k] = true; }
  return { weather: live(f.weather, round) ? f.weather.kind : null, terrain: live(f.terrain, round) ? f.terrain.kind : null, sides, trickRoom: live(f.trickRoom, round), raw: f, round };
}

export async function getField() {
  hook();
  const m = await OBR.scene.getMetadata();
  cache = { f: m[FIELD_KEY] ?? {}, round: Number(m[ROUND_KEY] ?? 1) };
  return m[FIELD_KEY] ?? {};
}
async function setField(f) {
  await OBR.scene.setMetadata({ [FIELD_KEY]: f });
}

const live = (e, round) => !!e && (e.until == null || round < e.until);

// what is active now: { weather, terrain, sides: { team: { reflect: true, ... } }, trickRoom }
// Air Lock / Cloud Nine on the field switch the weather off while they are there.
export async function fieldNow(f = null, round = null) {
  f ??= await getField();
  round ??= await roundNow();
  let weather = live(f.weather, round) ? f.weather.kind : null;
  if (weather) {
    const lock = await OBR.scene.items.getItems((i) => {
      const s = i.metadata?.[SHEET_KEY];
      if (!s || s.ball || (s.pkmn?.hp?.current ?? 0) <= 0) return false;
      const ab = s.battle?.ability ? [s.battle.ability] : s.pkmn?.abilities ?? [];
      return ab.includes("Air Lock") || ab.includes("Cloud Nine");
    });
    if (lock.length) weather = null;
  }
  const sides = {};
  for (const [team, eff] of Object.entries(f.sides ?? {})) {
    sides[team] = {};
    for (const [k, e] of Object.entries(eff)) if (live(e, round)) sides[team][k] = true;
  }
  return { weather, terrain: live(f.terrain, round) ? f.terrain.kind : null, sides, trickRoom: live(f.trickRoom, round), raw: f, round };
}

// starts a field effect from a move or ability. Returns a note for the log.
export async function startField(spec, { team = null, by = "" } = {}) {
  const f = await getField();
  const round = await roundNow();
  const until = round + (spec.rounds ?? 5);
  if (spec.weather) {
    // "usar enquanto já houver ... ativa não reinicia a duração"
    if (live(f.weather, round) && f.weather.kind === spec.weather) return `${WEATHER[spec.weather].label} já estava ativa`;
    f.weather = { kind: spec.weather, until, by };
    await setField(f);
    return `${WEATHER[spec.weather].icon} ${WEATHER[spec.weather].label} por ${spec.rounds ?? 5} rodadas`;
  }
  if (spec.terrain) {
    if (live(f.terrain, round) && f.terrain.kind === spec.terrain) return `${TERRAIN[spec.terrain].label} já estava ativo`;
    f.terrain = { kind: spec.terrain, until, by };
    await setField(f);
    return `${TERRAIN[spec.terrain].icon} ${TERRAIN[spec.terrain].label} por ${spec.rounds ?? 5} rodadas`;
  }
  if (spec.side && team) {
    f.sides ??= {};
    f.sides[team] ??= {};
    if (live(f.sides[team][spec.side], round)) return `${SIDE[spec.side].label} já está ativo (não reinicia)`;
    f.sides[team][spec.side] = { until, by };
    await setField(f);
    return `${SIDE[spec.side].icon} ${SIDE[spec.side].label} na equipe por ${spec.rounds ?? 5} rodadas`;
  }
  if (spec.trickRoom) {
    if (live(f.trickRoom, round)) { delete f.trickRoom; await setField(f); return "Trick Room desfeito"; }
    f.trickRoom = { until: until + 1, by }; // "a partir do início da próxima rodada"
    await setField(f);
    return "🔄 Trick Room: a ordem de iniciativa se inverte a partir da próxima rodada (5 rodadas)";
  }
  return "";
}

export async function clearTerrain() {
  const f = await getField();
  if (!f.terrain) return false;
  delete f.terrain;
  await setField(f);
  return true;
}
export async function clearSide(team, keys) {
  const f = await getField();
  let any = false;
  for (const k of keys) if (f.sides?.[team]?.[k]) { delete f.sides[team][k]; any = true; }
  if (any) await setField(f);
  return any;
}

// at the start of a round: what ran out
export async function expireField() {
  const f = await getField();
  const round = await roundNow();
  const gone = [];
  if (f.weather && !live(f.weather, round)) { gone.push(`${WEATHER[f.weather.kind]?.label ?? f.weather.kind} acabou`); delete f.weather; }
  if (f.terrain && !live(f.terrain, round)) { gone.push(`${TERRAIN[f.terrain.kind]?.label ?? f.terrain.kind} acabou`); delete f.terrain; }
  if (f.trickRoom && !live(f.trickRoom, round)) { gone.push("Trick Room acabou"); delete f.trickRoom; }
  for (const eff of Object.values(f.sides ?? {})) {
    for (const [k, e] of Object.entries(eff)) if (!live(e, round)) { gone.push(`${SIDE[k]?.label ?? k} acabou`); delete eff[k]; }
  }
  if (gone.length) await setField(f);
  return gone;
}

// one line for the HUD / panel
export function fieldText(now) {
  const parts = [];
  const left = (e) => (e?.until != null ? ` (${Math.max(0, e.until - now.round)} rod.)` : "");
  if (now.weather) parts.push(`${WEATHER[now.weather].icon} ${WEATHER[now.weather].label}${left(now.raw.weather)}`);
  if (now.terrain) parts.push(`${TERRAIN[now.terrain].icon} ${TERRAIN[now.terrain].label}${left(now.raw.terrain)}`);
  if (now.trickRoom) parts.push("🔄 Trick Room");
  for (const [team, eff] of Object.entries(now.sides)) {
    const ks = Object.keys(eff);
    if (ks.length) parts.push(`${team}: ${ks.map((k) => SIDE[k]?.label ?? k).join(", ")}`);
  }
  return parts.join(" · ");
}

// "no chão": not flying and not floating (Levitate, Magnet Rise)
export function grounded(sheet, abilities) {
  return !(Number(sheet?.battle?.alt) > 0) && !abilities.includes("Levitate") && !sheet?.battle?.magnetRise;
}
