// UI pieces shared by the pages: type colors and opening the popovers.
import { OBR, ID, HUD_ID, asset } from "./store.js?v=0.5.0";

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

// quick sheet in the bottom-left corner
export async function openHud(itemId) {
  const height = await OBR.viewport.getHeight();
  return OBR.popover.open({
    id: HUD_ID,
    url: asset(`hud.html?id=${encodeURIComponent(itemId)}`),
    width: 330,
    height: 300,
    anchorReference: "POSITION",
    anchorPosition: { left: 16, top: height - 76 },
    anchorOrigin: { horizontal: "LEFT", vertical: "BOTTOM" },
    transformOrigin: { horizontal: "LEFT", vertical: "BOTTOM" },
    disableClickAway: true, // targets are clicked on the map while it stays open
  });
}
