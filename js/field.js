// The battlefield as AREAS on the map: weather, terrain, screens (Reflect, Light Screen, Aurora Veil),
// Safeguard, Mist, Tailwind, hazards (Spikes, Stealth Rock, Toxic Spikes, Sticky Web) and the vortices
// of Whirlpool / Fire Spin / Sand Tomb... Each one is a circle (shape item, DRAWING layer) with
// metadata[AREA_KEY] = { kind, effect, move, by, byId, team, r (meters), left (rounds), until (round) }.
//   - weather and Tailwind follow the user ("sempre centrado em você e acompanhando seus movimentos");
//     terrain, screens, Safeguard, Mist stay where they were made; hazards sit on a point (draggable);
//     vortices sit under the target.
//   - the effects count only for who is inside (fieldNow(…, item));
//   - an area with a duration joins Pretty Sordid right after its user, "Sunny Day (5)": on its turn
//     the count goes down (areaTurn) and at 0 it disappears. Out of combat it runs out by the round.
// Trick Room has no area: it stays in the scene metadata (FIELD_KEY).
import { OBR, SDK, ID, SHEET_KEY, getSheet, updateSheet, pushLog, asset } from "./store.js?v=0.9.14";

export const FIELD_KEY = "com.pmp-fichas/field";
export const AREA_KEY = `${ID}/area`;
export const MARKER_KEY = `${ID}/areaMarker`;
const ROUND_KEY = "com.pretty-initiative/roundCount";
const PRETTY = "com.pretty-initiative/metadata";

export const WEATHER = {
  rain: { label: "Chuva", icon: "🌧️", color: "#3b82f6" },
  sun: { label: "Luz solar intensa", icon: "☀️", color: "#f59e0b" },
  sand: { label: "Tempestade de areia", icon: "🌪️", color: "#b08d57" },
  hail: { label: "Granizo", icon: "🌨️", color: "#93c5fd" },
  snow: { label: "Neve", icon: "❄️", color: "#e0f2fe" },
};
export const TERRAIN = {
  electric: { label: "Electric Terrain", type: "Electric", icon: "⚡", color: "#facc15" },
  grassy: { label: "Grassy Terrain", type: "Grass", icon: "🌿", color: "#22c55e" },
  misty: { label: "Misty Terrain", type: "Fairy", icon: "🌫️", color: "#f9a8d4" },
  psychic: { label: "Psychic Terrain", type: "Psychic", icon: "🔮", color: "#c084fc" },
};
export const SIDE = {
  reflect: { label: "Reflect", icon: "🟦", color: "#60a5fa" },
  lightScreen: { label: "Light Screen", icon: "🟨", color: "#fde047" },
  auroraVeil: { label: "Aurora Veil", icon: "🌈", color: "#a5f3fc" },
  safeguard: { label: "Safeguard", icon: "🛡️", color: "#a7f3d0" },
  mist: { label: "Mist", icon: "💨", color: "#e5e7eb" },
  tailwind: { label: "Tailwind", icon: "🍃", color: "#86efac" },
};
export const HAZARD = {
  spikes: { label: "Spikes", icon: "📌", color: "#9ca3af" },
  toxicSpikes: { label: "Toxic Spikes", icon: "☠️", color: "#a855f7" },
  stealthRock: { label: "Stealth Rock", icon: "🪨", color: "#a16207" },
  stickyWeb: { label: "Sticky Web", icon: "🕸️", color: "#d1d5db" },
};
export const VORTEX_COLOR = { Water: "#0ea5e9", Fire: "#ef4444", Ground: "#ca8a04", Bug: "#84cc16" };

// moves that make an area: radius in meters, follow = attached to the user, at = "user" | "target"
export const FIELD_MOVES = {
  "Rain Dance": { weather: "rain", rounds: 5, r: 15, follow: true }, "Sunny Day": { weather: "sun", rounds: 5, r: 15, follow: true },
  Sandstorm: { weather: "sand", rounds: 5, r: 15, follow: true }, Hail: { weather: "hail", rounds: 5, r: 15, follow: true },
  Snowscape: { weather: "snow", rounds: 5, r: 15, follow: true }, "Chilly Reception": { weather: "snow", rounds: 5, r: 15, follow: true },
  "Electric Terrain": { terrain: "electric", rounds: 5, r: 12 }, "Grassy Terrain": { terrain: "grassy", rounds: 5, r: 12 },
  "Misty Terrain": { terrain: "misty", rounds: 5, r: 12 }, "Psychic Terrain": { terrain: "psychic", rounds: 5, r: 12 },
  Reflect: { side: "reflect", rounds: 5, r: 4.5 }, "Light Screen": { side: "lightScreen", rounds: 5, r: 4.5 },
  "Aurora Veil": { side: "auroraVeil", rounds: 5, r: 6, needs: ["hail", "snow"] },
  Safeguard: { side: "safeguard", rounds: 5, r: 6 }, Mist: { side: "mist", rounds: 5, r: 9 },
  Tailwind: { side: "tailwind", rounds: 4, r: 15, follow: true },
  Spikes: { hazard: "spikes", r: 6, at: "target" }, "Toxic Spikes": { hazard: "toxicSpikes", r: 6, at: "target" },
  "Stealth Rock": { hazard: "stealthRock", r: 6, at: "target" }, "Sticky Web": { hazard: "stickyWeb", r: 6, at: "target" },
  "Trick Room": { trickRoom: true, rounds: 5 },
};
// "um redemoinho surge abaixo da criatura em um círculo de 1,5 m ... por 5 rodadas"
export const VORTEX_MOVES = { Whirlpool: "Water", "Fire Spin": "Fire", "Sand Tomb": "Ground", Infestation: "Bug", "Magma Storm": "Fire", "G-Max Sandblast": "Ground" };
// abilities that set the weather/terrain when the Pokémon comes in
export const FIELD_ABILITIES = {
  Drizzle: { weather: "rain", r: 15, follow: true }, Drought: { weather: "sun", r: 15, follow: true }, "Orichalcum Pulse": { weather: "sun", r: 15, follow: true },
  "Sand Stream": { weather: "sand", r: 15, follow: true }, "Snow Warning": { weather: "hail", r: 15, follow: true },
  "Electric Surge": { terrain: "electric", r: 12 }, "Hadron Engine": { terrain: "electric", r: 12 }, "Grassy Surge": { terrain: "grassy", r: 12 },
  "Misty Surge": { terrain: "misty", r: 12 }, "Psychic Surge": { terrain: "psychic", r: 12 },
};

export const roundNow = async () => Number((await OBR.scene.getMetadata())[ROUND_KEY] ?? 1);
export const areaOf = (item) => item?.metadata?.[AREA_KEY] ?? null;
const live = (e, round) => !!e && (e.until == null || round < e.until);
const areaLive = (a, round) => (a.left == null || a.left > 0) && (a.inInit || a.until == null || round < a.until);

// grid geometry: meters per cell and pixels per cell along x (isometric grids aren't square)
let geo = null;
async function geometry() {
  if (geo) return geo;
  const [dpi, scale, d] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale(), OBR.scene.grid.getDistance({ x: 0, y: 0 }, { x: 1000, y: 0 })]);
  const unit = { m: 1, ft: 0.3048, km: 1000, mi: 1609.34 }[scale.parsed?.unit?.toLowerCase?.()] ?? 1;
  geo = { dpi, cellM: (scale.parsed?.multiplier ?? 1.5) * unit, pxPerCell: d > 0 ? 1000 / d : dpi };
  return geo;
}
async function metersBetween(p, q) {
  const g = await geometry();
  return (await OBR.scene.grid.getDistance(p, q)) * g.cellM;
}
// inside: the creature's center within the radius (+ ½ square: "ocupando total ou parcialmente")
const inside = (d, a) => d <= a.r + 0.75 + 0.05;

export async function getAreas() {
  return OBR.scene.items.getItems((i) => !!i.metadata?.[AREA_KEY]);
}
export async function getField() {
  hook();
  return (await OBR.scene.getMetadata())[FIELD_KEY] ?? {};
}

// What counts here. With an item: only the areas it stands in; without: everything on the map (HUD).
// { weather, terrain, sides: { team: { reflect, ... } }, hazards: [...], vortex: [...], trickRoom, raw, round, areas }
// Air Lock / Cloud Nine on the field switch the weather off while they are there.
export async function fieldNow(f = null, round = null, item = null) {
  f ??= await getField();
  round ??= await roundNow();
  const areas = (await getAreas()).filter((a) => areaLive(areaOf(a), round));
  const here = [];
  for (const a of areas) {
    if (!item) { here.push(a); continue; }
    if (inside(await metersBetween(a.position, item.position), areaOf(a))) here.push(a);
  }
  const latest = (list) => list.sort((x, y) => (areaOf(x).at ?? 0) - (areaOf(y).at ?? 0)).pop();
  let weather = areaOf(latest(here.filter((a) => areaOf(a).kind === "weather")))?.effect ?? null;
  if (weather) {
    const lock = await OBR.scene.items.getItems((i) => {
      const s = i.metadata?.[SHEET_KEY];
      if (!s || s.ball || (s.pkmn?.hp?.current ?? 0) <= 0) return false;
      const ab = s.battle?.ability ? [s.battle.ability] : s.pkmn?.abilities ?? [];
      return ab.includes("Air Lock") || ab.includes("Cloud Nine");
    });
    if (lock.length) weather = null;
  }
  const terrain = areaOf(latest(here.filter((a) => areaOf(a).kind === "terrain")))?.effect ?? null;
  const sides = {};
  for (const a of here.filter((x) => areaOf(x).kind === "side")) {
    const m = areaOf(a);
    sides[m.team] ??= {};
    sides[m.team][m.effect] = true;
  }
  return {
    weather, terrain, sides, trickRoom: live(f.trickRoom, round), raw: f, round, areas: here,
    hazards: here.filter((a) => areaOf(a).kind === "hazard"), vortex: here.filter((a) => areaOf(a).kind === "vortex"),
  };
}

// a copy in memory for the code that can't wait (movement): areas and their positions, updated on
// every change; membership by pixel distance (close enough for Swift Swim / Tailwind)
let cache = { areas: [], round: 1, f: {} };
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  try {
    const keep = (items) => { cache.areas = items.filter((i) => i.metadata?.[AREA_KEY]); };
    OBR.scene.items.onChange(keep);
    OBR.scene.items.getItems((i) => !!i.metadata?.[AREA_KEY]).then((a) => { cache.areas = a; }).catch(() => {});
    OBR.scene.onMetadataChange((m) => { cache.round = Number(m[ROUND_KEY] ?? 1); cache.f = m[FIELD_KEY] ?? {}; });
    geometry().catch(() => {});
  } catch { hooked = false; }
}
export function fieldCached(item = null) {
  hook();
  const out = { weather: null, terrain: null, sides: {}, trickRoom: live(cache.f.trickRoom, cache.round), round: cache.round, raw: cache.f };
  const g = geo ?? { pxPerCell: 150, cellM: 1.5 };
  for (const a of cache.areas) {
    const m = areaOf(a);
    if (!areaLive(m, cache.round)) continue;
    if (item) {
      const px = Math.hypot(a.position.x - item.position.x, a.position.y - item.position.y);
      if (!inside((px / g.pxPerCell) * g.cellM, m)) continue;
    }
    if (m.kind === "weather") out.weather = m.effect;
    if (m.kind === "terrain") out.terrain = m.effect;
    if (m.kind === "side") { out.sides[m.team] ??= {}; out.sides[m.team][m.effect] = true; }
  }
  return out;
}

const labelOf = (m) => m.kind === "weather" ? WEATHER[m.effect]?.label : m.kind === "terrain" ? TERRAIN[m.effect]?.label
  : m.kind === "side" ? SIDE[m.effect]?.label : m.kind === "hazard" ? HAZARD[m.effect]?.label : m.move;
const iconOf = (m) => (m.kind === "weather" ? WEATHER : m.kind === "terrain" ? TERRAIN : m.kind === "side" ? SIDE : m.kind === "hazard" ? HAZARD : {})[m.effect]?.icon ?? "🌀";
export const areaName = (m) => `${iconOf(m)} ${m.move ?? labelOf(m)}${m.left != null ? ` (${m.left})` : ""}`;

// creates the area. ctx: { team, by (name), user (item), target (item), move }
// spec: { weather | terrain | side | hazard | vortex (type) | trickRoom, rounds, r, follow, at }
export async function startField(spec, ctx = {}) {
  const round = await roundNow();
  if (spec.trickRoom) {
    const f = await getField();
    if (live(f.trickRoom, round)) { delete f.trickRoom; await OBR.scene.setMetadata({ [FIELD_KEY]: f }); return "Trick Room desfeito"; }
    f.trickRoom = { until: round + (spec.rounds ?? 5) + 1, by: ctx.by };
    await OBR.scene.setMetadata({ [FIELD_KEY]: f });
    return "🔄 Trick Room: a ordem de iniciativa se inverte a partir da próxima rodada (5 rodadas)";
  }
  const user = ctx.user ?? null;
  const center = spec.at === "target" && ctx.target ? ctx.target : user;
  if (!center) return "";
  const kind = spec.weather ? "weather" : spec.terrain ? "terrain" : spec.side ? "side" : spec.hazard ? "hazard" : spec.vortex ? "vortex" : null;
  const effect = spec.weather ?? spec.terrain ?? spec.side ?? spec.hazard ?? spec.vortex;
  const r = spec.r ?? (spec.vortex ? 0.75 : 6);
  const areas = await getAreas();
  const team = ctx.team ?? (user ? getSheet(user)?.team ?? "inimigos" : null);
  // the same weather/terrain already over this spot: "não reinicia a duração"; another one touching
  // it is replaced ("outro clima ativado em seguida e a área dele esteja encostada na sua")
  const gone = [];
  for (const a of areas) {
    const m = areaOf(a);
    if (m.kind !== kind || !["weather", "terrain"].includes(kind)) continue;
    const d = await metersBetween(a.position, center.position);
    if (d > m.r + r) continue;
    if (m.effect === effect && d <= m.r) return `${labelOf(m)} já estava ativo aqui (não reinicia)`;
    gone.push(a.id);
  }
  // screens/Safeguard/Mist of the same team already here; hazards: 2 of each per user (the oldest goes)
  if (kind === "side") {
    for (const a of areas) {
      const m = areaOf(a);
      if (m.kind === "side" && m.effect === effect && m.team === team && (await metersBetween(a.position, center.position)) <= m.r) return `${labelOf(m)} já está ativo (não reinicia)`;
    }
  }
  if (kind === "hazard" && user) {
    const mine = areas.filter((a) => areaOf(a).kind === "hazard" && areaOf(a).effect === effect && areaOf(a).byId === user.id).sort((x, y) => areaOf(x).at - areaOf(y).at);
    if (mine.length >= 2) gone.push(mine[0].id);
  }
  if (gone.length) await removeAreas(gone);
  const g = await geometry();
  const diameter = ((2 * r) / g.cellM) * g.pxPerCell;
  const color = kind === "weather" ? WEATHER[effect].color : kind === "terrain" ? TERRAIN[effect].color : kind === "side" ? SIDE[effect].color
    : kind === "hazard" ? HAZARD[effect].color : VORTEX_COLOR[effect] ?? "#94a3b8";
  const rounds = spec.rounds ?? (kind === "vortex" ? 5 : null);
  // in Pretty Sordid right after its user (who used it, or who it was used by)
  const uInit = user?.metadata?.[PRETTY];
  const inInit = rounds != null && typeof uInit?.count === "string";
  const meta = { kind, effect, move: ctx.move ?? null, by: ctx.by ?? "", byId: user?.id ?? null, team, r, left: rounds, until: rounds != null ? round + rounds : null, at: Date.now(), inInit };
  let b = SDK.buildShape().shapeType("CIRCLE").width(diameter).height(diameter).position({ ...center.position })
    .fillColor(color).fillOpacity(kind === "vortex" ? 0.35 : 0.14).strokeColor(color).strokeOpacity(0.9).strokeWidth(Math.max(2, g.dpi * 0.03))
    .layer("DRAWING").name(areaName(meta)).locked(kind !== "hazard").disableHit(kind !== "hazard")
    .metadata({ [AREA_KEY]: meta });
  if (spec.follow && user) b = b.attachedTo(user.id).disableAttachmentBehavior(["VISIBLE", "SCALE", "ROTATION", "LOCKED", "COPY"]);
  const item = b.build();
  const add = [item];
  // Pretty Sordid lists tokens (images), not shapes: a small marker on the circle stands in the
  // initiative for it, right after its user, with the rounds left in its name
  if (inInit) {
    const size = 64;
    add.push(SDK.buildImage({ url: asset("icons/area.svg"), width: size, height: size, mime: "image/svg+xml" }, { dpi: size * 2, offset: { x: size / 2, y: size / 2 } })
      .name(areaName(meta)).position({ ...center.position }).layer("CHARACTER").locked(true).disableHit(true)
      .attachedTo(item.id).disableAttachmentBehavior(["SCALE", "ROTATION", "LOCKED", "COPY"])
      .metadata({ [MARKER_KEY]: { areaId: item.id }, [PRETTY]: { count: String(Math.round((parseFloat(uInit.count) - 0.01) * 100) / 100), active: false } })
      .build());
  }
  await OBR.scene.items.addItems(add);
  if (inInit) await reorderInitiative();
  const what = labelOf(meta);
  return `${iconOf(meta)} ${what}${rounds != null ? ` por ${rounds} rodadas` : ""}${kind === "side" ? ` (aliados a até ${String(r).replace(".", ",")} m)` : ""}`;
}

// Pretty Sordid's order after an area joined (same sort as map.setInitiative)
async function reorderInitiative() {
  const ascending = (await OBR.room.getMetadata())["com.pretty-initiative/sortAscending"] === true;
  const items = await OBR.scene.items.getItems((i) => typeof i.metadata?.[PRETTY]?.count === "string");
  const n = (i) => parseFloat(i.metadata[PRETTY].count) || 0;
  items.sort((a, b) => (ascending ? n(a) - n(b) : n(b) - n(a)));
  await OBR.scene.setMetadata({ "com.pretty-initiative/order": Object.fromEntries(items.map((it, i) => [i, it.id])) });
}
export async function removeAreas(ids) {
  if (!ids.length) return;
  // their initiative markers go with them
  const markers = await OBR.scene.items.getItems((i) => ids.includes(i.metadata?.[MARKER_KEY]?.areaId));
  ids = [...ids, ...markers.map((m) => m.id)];
  const meta = await OBR.scene.getMetadata();
  const order = Object.values(meta["com.pretty-initiative/order"] ?? {}).filter((id) => !ids.includes(id));
  await OBR.scene.items.deleteItems(ids);
  await OBR.scene.setMetadata({ "com.pretty-initiative/order": Object.fromEntries(order.map((id, i) => [i, id])) });
}

// its turn in the initiative: one round less; at 0 it ends. Returns a note.
// (called with the marker that is in the initiative, or the area itself)
export async function areaTurn(item) {
  if (item?.metadata?.[MARKER_KEY]) [item] = await OBR.scene.items.getItems([item.metadata[MARKER_KEY].areaId]);
  const m = areaOf(item);
  if (!m) return null;
  const left = (m.left ?? 1) - 1;
  if (left <= 0) { await removeAreas([item.id]); return `${labelOf(m)} acabou`; }
  const markers = await OBR.scene.items.getItems((i) => i.metadata?.[MARKER_KEY]?.areaId === item.id);
  await OBR.scene.items.updateItems([item.id, ...markers.map((x) => x.id)], (ds) => {
    for (const d0 of ds) { if (d0.metadata[AREA_KEY]) d0.metadata[AREA_KEY] = { ...d0.metadata[AREA_KEY], left }; d0.name = areaName({ ...m, left }); }
  });
  return `${labelOf(m)}: falta(m) ${left} rodada(s)`;
}
// the initiative marker of an area
export const isAreaTurn = (item) => !!(item?.metadata?.[AREA_KEY] || item?.metadata?.[MARKER_KEY]);

export async function clearTerrain(item = null) {
  const areas = (await getAreas()).filter((a) => areaOf(a).kind === "terrain");
  const ids = [];
  for (const a of areas) if (!item || inside(await metersBetween(a.position, item.position), areaOf(a))) ids.push(a.id);
  await removeAreas(ids);
  return ids.length > 0;
}
export async function clearSide(team, keys, item = null) {
  const areas = (await getAreas()).filter((a) => areaOf(a).kind === "side" && areaOf(a).team === team && keys.includes(areaOf(a).effect));
  const ids = [];
  for (const a of areas) if (!item || inside(await metersBetween(a.position, item.position), areaOf(a))) ids.push(a.id);
  await removeAreas(ids);
  return ids.length > 0;
}

// at the start of a round: areas out of the initiative that ran out (and Trick Room)
export async function expireField() {
  const round = await roundNow();
  const gone = [];
  const ids = [];
  const counted = new Set((await OBR.scene.items.getItems((i) => i.metadata?.[MARKER_KEY] && i.metadata?.[PRETTY])).map((i) => i.metadata[MARKER_KEY].areaId));
  for (const a of await getAreas()) {
    const m = areaOf(a);
    if (counted.has(a.id)) continue; // counted on its own turn in the initiative
    if (m.until != null && round >= m.until) { ids.push(a.id); gone.push(`${labelOf(m)} acabou`); }
  }
  await removeAreas(ids);
  const f = await getField();
  if (f.trickRoom && !live(f.trickRoom, round)) { delete f.trickRoom; await OBR.scene.setMetadata({ [FIELD_KEY]: f }); gone.push("Trick Room acabou"); }
  return gone;
}

// the user went back to the ball: its following areas move to who came in, or stay where they are
export async function handOverAreas(fromItem, toItem = null) {
  const mine = (await getAreas()).filter((a) => a.attachedTo === fromItem.id);
  if (!mine.length) return;
  await OBR.scene.items.updateItems(mine.map((a) => a.id), (ds) => {
    for (const d0 of ds) {
      if (toItem) { d0.attachedTo = toItem.id; d0.position = { ...toItem.position }; d0.metadata[AREA_KEY] = { ...d0.metadata[AREA_KEY], byId: toItem.id }; }
      else delete d0.attachedTo;
    }
  });
}

// one line for the HUD / panel
export function fieldText(now) {
  const parts = [];
  for (const a of now.areas ?? []) parts.push(areaName(areaOf(a)));
  if (now.trickRoom) parts.push("🔄 Trick Room");
  return [...new Set(parts)].join(" · ");
}

// "no chão": not flying and not floating (Levitate, Magnet Rise)
export function grounded(sheet, abilities) {
  return !(Number(sheet?.battle?.alt) > 0) && !abilities.includes("Levitate") && !sheet?.battle?.magnetRise;
}

// ------------------------------------------------------------------ walking into hazards and vortices
// "Sempre que uma criatura entrar nessa área, ou quando um Pokémon for substituído e o próximo surgir
// dentro dela": from (null = it just appeared) -> to. Vortices: entering or leaving hurts (once a turn).
export async function hazardsOnMove(rules, item, from, to, { giveCondition, addStage } = {}) {
  const s = getSheet(item);
  if (!s || s.ball || s.pkmn.hp.current <= 0) return [];
  const notes = [];
  const types = rules.types(s.pkmn);
  const ab = s.battle?.ability ? [s.battle.ability] : rules.abilities(s.pkmn);
  const up = Number(s.battle?.alt) > 0 || ab.includes("Levitate") || s.battle?.magnetRise;
  const lvl = rules.level(s.pkmn);
  const half = Math.max(2, Math.ceil(lvl / 2));
  const ops = [];
  for (const a of await getAreas()) {
    const m = areaOf(a);
    if (m.kind !== "hazard" && m.kind !== "vortex") continue;
    const was = from ? inside(await metersBetween(a.position, from), m) : false;
    const now = inside(await metersBetween(a.position, to), m);
    if (m.kind === "hazard" && !was && now) {
      if (m.effect === "spikes" && !up && !types.includes("Flying")) ops.push({ dmg: half, note: `📌 Spikes: −${half} HP` });
      if (m.effect === "stealthRock") { const e = rules.effectiveness("Rock", s.pkmn); const n = Math.floor(half * e); ops.push({ dmg: n, note: `🪨 Stealth Rock: −${n} HP` }); }
      if (m.effect === "toxicSpikes" && !up && !types.includes("Flying")) ops.push({ give: m.strong ? "BadlyPoisoned" : "Poisoned", note: "☠️ Toxic Spikes" });
      if (m.effect === "stickyWeb" && !up && !types.includes("Flying")) ops.push({ stage: { stat: "Speed", delta: -1 }, note: "🕸️ Sticky Web: Velocidade −1" });
    }
    if (m.kind === "vortex" && from && was !== now) {
      const turn = s.battle?.turns ?? 0;
      if (s.battle?.vortexHurt !== turn) {
        const e = rules.effectiveness(m.effect, s.pkmn);
        const n = Math.floor(half * e);
        ops.push({ dmg: n, vortexTurn: turn, note: `🌀 ${m.move ?? "redemoinho"} (${now ? "entrou" : "saiu"}): −${n} HP` });
      }
    }
  }
  if (!ops.length) return notes;
  if (ab.includes("Magic Guard")) for (const o of ops) delete o.dmg;
  await updateSheet(item.id, (sh) => {
    for (const o of ops) {
      if (o.dmg) sh.pkmn.hp.current = Math.max(0, sh.pkmn.hp.current - o.dmg);
      if (o.vortexTurn != null) sh.battle.vortexHurt = o.vortexTurn;
      if (o.give && giveCondition) { const r0 = giveCondition(sh, o.give, rules, {}); notes.push(r0.ok ? o.note : `${o.note}: ${r0.reason}`); continue; }
      if (o.stage && addStage) addStage(sh.pkmn, o.stage.stat, o.stage.delta);
      if (o.note) notes.push(o.note);
    }
  });
  if (notes.length) await pushLog({ kind: "note", attacker: item.name, text: notes.join("; ") });
  // the HP lost shows up on the token, like an attack's damage
  const lost = ops.reduce((a, o) => a + (o.dmg ?? 0), 0);
  if (lost > 0) await OBR.broadcast.sendMessage("com.pmp-fichas/fx", { from: to, hits: [{ to, kind: "hit", text: `-${lost}` }] }, { destination: "ALL" }).catch(() => {});
  return notes;
}
// end of its own turn inside a vortex: half its level, untyped
export async function vortexEndTurn(rules, item) {
  const s = getSheet(item);
  if (!s || s.pkmn.hp.current <= 0) return null;
  for (const a of await getAreas()) {
    const m = areaOf(a);
    if (m.kind !== "vortex" || !areaLive(m, await roundNow())) continue;
    if (inside(await metersBetween(a.position, item.position), m)) return { amount: Math.max(2, Math.ceil(rules.level(s.pkmn) / 2)), move: m.move };
  }
  return null;
}
