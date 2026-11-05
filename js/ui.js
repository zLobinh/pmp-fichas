// UI pieces shared by the pages: type colors and opening the popovers.
import { OBR, ID, HUD_ID, asset } from "./store.js?v=0.7.0";

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

// quick sheet: where the player last dragged it (bottom-left corner of the popover), per browser
const HUD_POS_KEY = `${ID}/hudPos`;
export function hudPosition(height) {
  try {
    const p = JSON.parse(localStorage.getItem(HUD_POS_KEY) || "null");
    if (p && Number.isFinite(p.left) && Number.isFinite(p.bottom)) return p;
  } catch {}
  return { left: 16, bottom: height - 76 };
}
export function saveHudPosition(p) {
  try { localStorage.setItem(HUD_POS_KEY, JSON.stringify(p)); } catch {}
}

// quick sheet in the bottom-left corner (or where it was dragged to)
export async function openHud(itemId, extra = "") {
  const [width, height] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
  const pos = hudPosition(height);
  // keep it on screen if the window got smaller
  const left = Math.max(0, Math.min(width - 120, pos.left));
  const bottom = Math.max(120, Math.min(height, pos.bottom));
  return OBR.popover.open({
    id: HUD_ID,
    url: asset(`hud.html?id=${encodeURIComponent(itemId)}${extra}`),
    width: 330,
    height: 300,
    anchorReference: "POSITION",
    anchorPosition: { left, top: bottom },
    anchorOrigin: { horizontal: "LEFT", vertical: "BOTTOM" },
    transformOrigin: { horizontal: "LEFT", vertical: "BOTTOM" },
    disableClickAway: true, // targets are clicked on the map while it stays open
  });
}
