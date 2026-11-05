// Shared helpers: OBR SDK, data loading, sheet storage on tokens and the combat log.
import OBR, * as SDK from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { Rules } from "./rules.js?v=0.7.0";

export { OBR, SDK };
export const ID = "com.pmp-fichas";
export const SHEET_KEY = `${ID}/sheet`;
export const LOG_KEY = `${ID}/log`;
export const SETTINGS_KEY = `${ID}/settings`;
export const LOG_CHANNEL = `${ID}/roll`;
export const LOG_MAX = 30;
export const HUD_ID = `${ID}/hud`;

export const STATUSES = {
  Burning: "Queimado",
  Frozen: "Congelado",
  Paralyzed: "Paralisado",
  Poisoned: "Envenenado",
  Asleep: "Dormindo",
  Confused: "Confuso",
};

// set by tools/bump_version.py
export const VERSION = "0.7.0";

// absolute URL of a file of this extension (works on a GitHub Pages sub-path), tagged with the
// version so browsers don't keep serving the previous one from their cache
export const asset = (path) => {
  const url = new URL(`../${path}`, import.meta.url);
  url.searchParams.set("v", VERSION);
  return url.href;
};

let rulesPromise;
export function loadRules() {
  rulesPromise ??= Promise.all(
    ["moves", "pokemon", "rules"].map((f) => fetch(asset(`data/${f}.json`)).then((r) => r.json())),
  ).then(([moves, pokemon, rules]) => new Rules({ moves, pokemon, rules }));
  return rulesPromise;
}

export const getSheet = (item) => item?.metadata?.[SHEET_KEY] ?? null;

export async function getItem(id) {
  return (await OBR.scene.items.getItems([id]))[0] ?? null;
}

// mutate a token's sheet; fn receives the Pokémon JSON (the app's format).
// The drafts are immer proxies (they can't be structuredClone'd), so fn edits the draft in place.
export async function updatePokemon(id, fn) {
  await OBR.scene.items.updateItems([id], (drafts) => {
    for (const d of drafts) {
      const sheet = d.metadata[SHEET_KEY];
      if (!sheet) continue;
      sheet.pkmn.hp ??= { current: 0, max: 0 };
      sheet.pkmn.moves ??= {};
      fn(sheet.pkmn);
      sheet.updated = Date.now();
    }
  });
}

// mutate a token's whole sheet: fn(sheet) gets { pkmn, battle, owner } and may change both
export async function updateSheet(id, fn) {
  await OBR.scene.items.updateItems([id], (drafts) => {
    for (const d of drafts) {
      const sheet = d.metadata[SHEET_KEY];
      if (!sheet) continue;
      sheet.pkmn.hp ??= { current: 0, max: 0 };
      sheet.pkmn.moves ??= {};
      sheet.battle ??= {};
      fn(sheet);
      sheet.updated = Date.now();
    }
  });
}

export async function canEdit(sheet) {
  if ((await OBR.player.getRole()) === "GM") return true;
  return sheet?.owner === OBR.player.id;
}

// ------------------------------------------------------------------ parsing the app's export

export function parseExport(text, rules) {
  let raw = (text ?? "").trim();
  if (!raw) throw new Error("Cole o código que o app gerou.");
  // Discord sometimes eats the last brace (the app handles this too)
  if (!raw.endsWith("}")) raw += "}";
  let pkmn;
  try {
    pkmn = JSON.parse(raw);
  } catch {
    throw new Error("Esse código não é um Pokémon exportado do app (JSON inválido).");
  }
  if (!pkmn?.species?.current || !pkmn?.hp || pkmn.hp.current == null) {
    throw new Error("O código não tem espécie ou HP. Use 'Exportar' na tela do Pokémon no app.");
  }
  if (!rules.speciesData(pkmn)) throw new Error(`Espécie desconhecida nos dados do PMP: ${pkmn.species.current}`);
  // the app's internal status format uses numbers; the export uses names
  const ids = { 1: "Burning", 2: "Frozen", 3: "Paralyzed", 4: "Poisoned", 5: "Asleep", 6: "Confused" };
  const st = {};
  for (const k of Object.keys(pkmn.statuses ?? {})) st[ids[k] ?? k] = true;
  pkmn.statuses = st;
  return pkmn;
}

// ------------------------------------------------------------------ combat log

export async function pushLog(entry) {
  const full = { ...entry, at: Date.now(), by: await OBR.player.getName() };
  const meta = await OBR.scene.getMetadata();
  const log = [full, ...(meta[LOG_KEY] ?? [])].slice(0, LOG_MAX);
  await OBR.scene.setMetadata({ [LOG_KEY]: log });
  await OBR.broadcast.sendMessage(LOG_CHANNEL, full, { destination: "ALL" });
}

export async function getSettings() {
  const meta = await OBR.room.getMetadata();
  return { autoDamage: true, autoPP: true, checkRange: true, mapFx: true, dicePlus: true, dicePlusPopup: false, ...(meta[SETTINGS_KEY] ?? {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  await OBR.room.setMetadata({ [SETTINGS_KEY]: { ...current, ...patch } });
}

// ------------------------------------------------------------------ small DOM helpers

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

export async function syncTheme() {
  const apply = (t) => document.documentElement.setAttribute("data-theme", t.mode === "LIGHT" ? "light" : "dark");
  apply(await OBR.theme.getTheme());
  OBR.theme.onChange(apply);
}
