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

// grid: 150 px per square, 1.5 m per square. Charmander is 2 squares from Bulbasaur, Squirtle 10.
const token = (x) => ({ position: { x, y: 0 }, image: { width: 150, height: 150 }, grid: { dpi: 150 }, scale: { x: 1, y: 1 } });
const items = [
  { id: "a", name: "Bulbasaur", type: "IMAGE", layer: "CHARACTER", ...token(0), metadata: { "com.pmp-fichas/sheet": { pkmn: makePkmn("Bulbasaur", 20, ["Tackle", "Razor Leaf", "Acid Spray", "Struggle"]), owner: "me" } } },
  { id: "b", name: "Charmander", type: "IMAGE", layer: "CHARACTER", ...token(300), metadata: { "com.pmp-fichas/sheet": { pkmn: makePkmn("Charmander", 10, ["Ember", "Scratch"], { nature: "Alegre" }), owner: "gm" } } },
  { id: "c", name: "Squirtle", type: "IMAGE", layer: "CHARACTER", ...token(1500), metadata: {} },
  { id: "d", name: "Oddish", type: "IMAGE", layer: "CHARACTER", ...token(450), metadata: { "com.pmp-fichas/sheet": { pkmn: makePkmn("Oddish", 8, ["Absorb"]), owner: "gm" } } },
];
items[3].position = { x: 300, y: 300 }; // Oddish: 2 squares right, 2 down (diagonal)
let selection = ["b"];
const channels = {};
let sceneMeta = {};
let playerMeta = {};
let roomMeta = {};
const emit = (k, v) => listeners[k].forEach((f) => f(v));
const clone = (x) => structuredClone(x);

const OBR = {
  onReady: (cb) => setTimeout(cb, 0),
  isReady: true,
  scene: {
    grid: {
      getDpi: async () => 150,
      getScale: async () => ({ raw: "1.5m", parsed: { multiplier: 1.5, unit: "m", digits: 1 } }),
      // Chebyshev, like the Owlbear default
      getDistance: async (a, b) => Math.round(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 150),
    },
    local: { addItems: async () => {}, updateItems: async () => {}, deleteItems: async () => {} },
    isReady: async () => true,
    onReadyChange: () => () => {},
    getMetadata: async () => clone(sceneMeta),
    setMetadata: async (m) => { sceneMeta = { ...sceneMeta, ...m }; emit("scene", clone(sceneMeta)); },
    onMetadataChange: (f) => listeners.scene.push(f),
    items: {
      getItems: async (filter) => clone(Array.isArray(filter) ? items.filter((i) => filter.includes(i.id)) : typeof filter === "function" ? items.filter(filter) : items),
      updateItems: async (ids, fn) => {
        // like the real SDK (immer), drafts are proxies: structuredClone on them throws
        const wrap = (o) => new Proxy(o, { get: (t, k) => (t[k] && typeof t[k] === "object" ? wrap(t[k]) : t[k]) });
        const drafts = items.filter((i) => ids.includes(i.id)).map(wrap);
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
    select: async (ids) => { selection = ids; emit("player", { selection, metadata: clone(playerMeta) }); },
    getMetadata: async () => clone(playerMeta),
    setMetadata: async (m) => { playerMeta = { ...playerMeta, ...m }; emit("player", { selection, metadata: clone(playerMeta) }); },
    onChange: (f) => listeners.player.push(f),
  },
  room: {
    getMetadata: async () => clone(roomMeta),
    setMetadata: async (m) => { roomMeta = { ...roomMeta, ...m }; emit("room", clone(roomMeta)); },
    onMetadataChange: (f) => listeners.room.push(f),
  },
  theme: { getTheme: async () => ({ mode: "DARK" }), onChange: () => {} },
  notification: { show: async (msg, v) => { console.log("[notificação]", v, msg); (window.__notes ??= []).push(msg); } },
  // messages are delivered inside this page (enough to fake the background answering the sheet)
  broadcast: {
    sendMessage: async (ch, data) => {
      (window.__sent ??= []).push({ ch, data });
      setTimeout(() => (channels[ch] ?? []).forEach((f) => f({ data: clone(data) })), 0);
    },
    onMessage: (ch, f) => { (channels[ch] ??= []).push(f); return () => { channels[ch] = channels[ch].filter((x) => x !== f); }; },
  },
  popover: {
    open: async (o) => console.log("[popover.open]", o.url),
    close: async () => console.log("[popover.close]"),
    setHeight: async (id, height) => { document.body.style.height = `${height}px`; },
  },
  viewport: { getWidth: async () => 1280, getHeight: async () => 800 },
  modal: { open: async () => {}, close: async () => console.log("[modal.close]") },
  contextMenu: { create: () => {} },
};

// test hooks
window.__mock = {
  items,
  setSelection: (ids) => { selection = ids; emit("player", { selection, metadata: clone(playerMeta) }); },
  // stand-in for the background page: answers aim requests through the player metadata
  fakeBackground: (targetIds, delay = 600) => {
    (channels["com.pmp-fichas/aim-start"] ??= []).push(async ({ data }) => {
      await OBR.player.setMetadata({ "com.pmp-fichas/aim": { nonce: data.nonce, status: "active", attackerId: data.attackerId, moveName: data.moveName, targetIds: [] } });
      setTimeout(() => OBR.player.setMetadata({ "com.pmp-fichas/aim": { nonce: data.nonce, status: "done", attackerId: data.attackerId, moveName: data.moveName, targetIds } }), delay);
    });
  },
};
export default OBR;
