// UI pieces shared by the pages: type colors and opening the popovers.
import { OBR, ID, HUD_ID, asset } from "./store.js?v=0.9.19";

export const TYPE_COLOR = {
  Normal: "#9a9a7c", Fire: "#e2743a", Water: "#5a8de6", Grass: "#5fae4a", Electric: "#d8b41f", Ice: "#6cc4c4",
  Fighting: "#b3332c", Poison: "#9545a0", Ground: "#c9a554", Flying: "#8e7fe0", Psychic: "#e85583", Bug: "#93a823",
  Rock: "#ac9339", Ghost: "#6a5592", Dragon: "#6a3ef0", Dark: "#6b5546", Steel: "#9b9bb8", Fairy: "#d77fa8", Typeless: "#777",
};

export const SHEET_ID = `${ID}/sheet`;

// A die face. With animate, it tumbles through random numbers for ~0.7s and lands on the value.
// kind: "crit" | "fumble" | "" (colors the face)
export function die(value, { sides = 20, kind = "", animate = false } = {}) {
  const el = document.createElement("span");
  el.className = `die d${sides === 20 ? 20 : "x"} ${kind}`;
  el.title = `d${sides}`;
  if (!animate) {
    el.textContent = value;
    return el;
  }
  el.classList.add("rolling");
  let ticks = 0;
  const timer = setInterval(() => {
    el.textContent = 1 + Math.floor(Math.random() * sides);
    if (++ticks >= 12) {
      clearInterval(timer);
      el.textContent = value;
      el.classList.remove("rolling");
      el.classList.add("landed");
    }
  }, 55);
  el.textContent = 1 + Math.floor(Math.random() * sides);
  return el;
}
const AUTO_HUD_KEY = `${ID}/autoHud`;

// The open quick sheet writes a heartbeat here every second; the background only opens a new
// one when the heartbeat is stale (a flag cleared on "closed" got stuck when the popover closed
// some other way, and then the quick sheet never opened again).
const HUD_ALIVE_KEY = `${ID}/hudAlive`;
export function markHudAlive(on = true) {
  try { if (on) localStorage.setItem(HUD_ALIVE_KEY, String(Date.now())); else localStorage.removeItem(HUD_ALIVE_KEY); } catch {}
}
export function hudAlive() {
  try { return Date.now() - Number(localStorage.getItem(HUD_ALIVE_KEY) || 0) < 2500; } catch { return false; }
}

// a notification for every roll and damage: off by default (too many in a battle); per browser
const ROLL_NOTICE_KEY = `${ID}/rollNotices`;
export function rollNotices() {
  try { return localStorage.getItem(ROLL_NOTICE_KEY) === "1"; } catch { return false; }
}
export function setRollNotices(on) {
  try { localStorage.setItem(ROLL_NOTICE_KEY, on ? "1" : "0"); } catch {}
}

// per-player preference, kept in this browser
export function autoHudEnabled() {
  try { return localStorage.getItem(AUTO_HUD_KEY) !== "0"; } catch { return true; }
}
export function setAutoHud(on) {
  try { localStorage.setItem(AUTO_HUD_KEY, on ? "1" : "0"); } catch {}
}

// full sheet; next to the token when opened from its menu, top-right otherwise
export async function openSheet(itemId, anchorElementId) {
  const base = { id: SHEET_ID, url: asset(`sheet.html?id=${encodeURIComponent(itemId)}`), width: 400, height: 620, disableClickAway: true };
  if (anchorElementId) {
    return OBR.popover.open({
      ...base,
      anchorElementId,
      anchorOrigin: { horizontal: "RIGHT", vertical: "CENTER" },
      transformOrigin: { horizontal: "LEFT", vertical: "CENTER" },
    });
  }
  const width = await OBR.viewport.getWidth();
  return OBR.popover.open({
    ...base,
    anchorReference: "POSITION",
    anchorPosition: { left: width - 16, top: 70 },
    anchorOrigin: { horizontal: "RIGHT", vertical: "TOP" },
    transformOrigin: { horizontal: "RIGHT", vertical: "TOP" },
  });
}

// trainer's team panel, top-right (switchId: open already switching that Pokémon out)
export const TRAINER_ID = `${ID}/trainer`;
export async function openTrainer(trainerId, switchId = null) {
  const width = await OBR.viewport.getWidth();
  return OBR.popover.open({
    id: TRAINER_ID,
    url: asset(`trainer.html?id=${encodeURIComponent(trainerId)}${switchId ? `&switch=${encodeURIComponent(switchId)}` : ""}`),
    width: 560,
    height: 520,
    anchorReference: "POSITION",
    anchorPosition: { left: width - 16, top: 70 },
    anchorOrigin: { horizontal: "RIGHT", vertical: "TOP" },
    transformOrigin: { horizontal: "RIGHT", vertical: "TOP" },
    disableClickAway: true,
  });
}

// "Preparar batalha" popup, top-center
export const PREP_ID = `${ID}/prep`;
export async function openPrep() {
  const width = await OBR.viewport.getWidth();
  return OBR.popover.open({
    id: PREP_ID,
    url: asset("prep.html"),
    width: 440,
    height: 520,
    anchorReference: "POSITION",
    anchorPosition: { left: width / 2, top: 70 },
    anchorOrigin: { horizontal: "CENTER", vertical: "TOP" },
    transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
    disableClickAway: true,
  });
}

export const STAGES_ID = `${ID}/stages`;

// "Mudanças de Status" popup, in the middle-right of the screen
export async function openStages(itemId) {
  const [width, height] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
  return OBR.popover.open({
    id: STAGES_ID,
    url: asset(`stages.html?id=${encodeURIComponent(itemId)}`),
    width: 420,
    height: 560,
    anchorReference: "POSITION",
    anchorPosition: { left: width - 430, top: Math.max(70, height / 2 - 280) },
    anchorOrigin: { horizontal: "LEFT", vertical: "TOP" },
    transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
    disableClickAway: true,
  });
}

// Quick sheet placement, per browser. Owlbear trims a popover that doesn't fit between its anchor
// and the edge it grows towards, so: in the top half of the screen it hangs from its top edge and
// grows down; in the bottom half it stands on its bottom edge and grows up. Its last height is
// remembered so it opens at the right size, and `room` tells the page how tall it may get.
const HUD_POS_KEY = `${ID}/hudPos`;
const HUD_H_KEY = `${ID}/hudHeight`;
const HUD_ROOM_KEY = `${ID}/hudRoom`;
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const hudHeight = () => read(HUD_H_KEY) ?? 300;
export const saveHudHeight = (h) => write(HUD_H_KEY, Math.round(h));
export const hudRoom = () => read(HUD_ROOM_KEY) ?? 640; // max height that fits where it is
const HUD_ANCHOR_KEY = `${ID}/hudAnchor`;
// the popover's current top edge (in bottom mode it moves as the height changes)
export function hudTop(currentHeight, viewportHeight) {
  const a = read(HUD_ANCHOR_KEY);
  if (!a) return hudPosition(viewportHeight).top;
  return a.fromTop ? a.y : a.y - currentHeight;
}

// { left, top } of the popover's top-left corner
export function hudPosition(viewportHeight) {
  const p = read(HUD_POS_KEY);
  if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) return p;
  if (p && Number.isFinite(p.left) && Number.isFinite(p.bottom)) return { left: p.left, top: p.bottom - hudHeight() }; // old format
  return { left: 16, top: viewportHeight - 76 - hudHeight() };
}
export const saveHudPosition = (p) => write(HUD_POS_KEY, { left: Math.round(p.left), top: Math.round(p.top) });

// quick sheet in the bottom-left corner (or where it was dragged to)
export async function openHud(itemId, extra = "") {
  const [width, vh] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
  const pos = hudPosition(vh);
  const h = hudHeight();
  // keep it on screen if the window got smaller
  const left = Math.max(0, Math.min(width - 120, pos.left));
  const top = Math.max(8, Math.min(vh - 120, pos.top));
  const fromTop = top + h / 2 < vh / 2;
  const anchor = fromTop ? { left, top } : { left, top: Math.min(vh - 8, top + h) };
  const room = fromTop ? vh - top - 8 : anchor.top - 8;
  write(HUD_ROOM_KEY, room);
  write(HUD_ANCHOR_KEY, { fromTop, y: anchor.top });
  const v = fromTop ? "TOP" : "BOTTOM";
  return OBR.popover.open({
    id: HUD_ID,
    url: asset(`hud.html?id=${encodeURIComponent(itemId)}${extra}`),
    width: 330,
    height: Math.min(h, room),
    anchorReference: "POSITION",
    anchorPosition: anchor,
    anchorOrigin: { horizontal: "LEFT", vertical: v },
    transformOrigin: { horizontal: "LEFT", vertical: v },
    disableClickAway: true, // targets are clicked on the map while it stays open
  });
}
