// Minimal in-memory stand-in for the Owlbear SDK, to preview the extension pages outside Owlbear.
const listeners = { items: [], player: [], scene: [], room: [], theme: [], broadcast: [] };
const pokemon = await fetch(new URL("../data/pokemon.json", import.meta.url)).then((r) => r.json());

function makePkmn(species, level, moves, extra = {}) {
  const sp = pokemon[species];
  const conMod = Math.floor((sp.attributes.CON - 10) / 2);
  const max = sp.HP - sp["MIN LVL FD"] * conMod;
  return {
    species: { caught: species, current: species }, level: { caught: level, current: level },
    attributes: { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: 0, CHA: 0, increased: {}, custom: {} },
    nature: "No Nature", feats: [], abilities: [], loyalty: 0, statuses: {},
    hp: { max, current: max + level * conMod },
    moves: Object.fromEntries(moves.map((m, i) => [m, { index: i + 1 }])),
    ...extra,
  };
}

const items = [
  { id: "a", name: "Bulbasaur", type: "IMAGE", layer: "CHARACTER", metadata: { "com.pmp-fichas/sheet": { pkmn: makePkmn("Bulbasaur", 20, ["Tackle", "Razor Leaf", "Acid Spray", "Struggle"]), owner: "me" } } },
  { id: "b", name: "Charmander", type: "IMAGE", layer: "CHARACTER", metadata: { "com.pmp-fichas/sheet": { pkmn: makePkmn("Charmander", 10, ["Ember", "Scratch"], { nature: "Alegre" }), owner: "gm" } } },
  { id: "c", name: "Squirtle", type: "IMAGE", layer: "CHARACTER", metadata: {} },
];
let selection = ["b"];
let sceneMeta = {};
let roomMeta = {};
const emit = (k, v) => listeners[k].forEach((f) => f(v));
const clone = (x) => structuredClone(x);

const OBR = {
  onReady: (cb) => setTimeout(cb, 0),
  isReady: true,
  scene: {
    isReady: async () => true,
    onReadyChange: () => () => {},
    getMetadata: async () => clone(sceneMeta),
    setMetadata: async (m) => { sceneMeta = { ...sceneMeta, ...m }; emit("scene", clone(sceneMeta)); },
    onMetadataChange: (f) => listeners.scene.push(f),
    items: {
      getItems: async (filter) => clone(Array.isArray(filter) ? items.filter((i) => filter.includes(i.id)) : typeof filter === "function" ? items.filter(filter) : items),
      updateItems: async (ids, fn) => {
        const drafts = items.filter((i) => ids.includes(i.id));
        fn(drafts);
        emit("items", clone(items));
      },
      onChange: (f) => listeners.items.push(f),
    },
  },
  player: {
    id: "me",
    getRole: async () => "GM",
    getName: async () => "Mestre",
    getSelection: async () => [...selection],
    select: async (ids) => { selection = ids; emit("player", { selection }); },
    onChange: (f) => listeners.player.push(f),
  },
  room: {
    getMetadata: async () => clone(roomMeta),
    setMetadata: async (m) => { roomMeta = { ...roomMeta, ...m }; emit("room", clone(roomMeta)); },
    onMetadataChange: (f) => listeners.room.push(f),
  },
  theme: { getTheme: async () => ({ mode: "DARK" }), onChange: () => {} },
  notification: { show: async (msg, v) => { console.log("[notificação]", v, msg); (window.__notes ??= []).push(msg); } },
  broadcast: { sendMessage: async (ch, data) => console.log("[broadcast]", ch, data), onMessage: () => {} },
  popover: { open: async (o) => console.log("[popover.open]", o.url), close: async () => console.log("[popover.close]") },
  modal: { open: async () => {}, close: async () => console.log("[modal.close]") },
  contextMenu: { create: () => {} },
};

// test hooks
window.__mock = { items, setSelection: (ids) => { selection = ids; emit("player", { selection }); } };
export default OBR;
