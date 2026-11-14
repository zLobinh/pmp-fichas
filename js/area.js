// Area templates for "Pessoal (cone/linha/raio/semicírculo de X metros)" moves.
// Runs in the background page: a temporary tool draws the template from the Pokémon toward the
// mouse, shows who is inside, and on click hands the targets back to the sheet that asked.
//
// Sheet -> background: broadcast AIM_START / AIM_ABORT.
// Background -> sheet: the aim state in this player's metadata (AIM_KEY), which every page of the
// extension sees through OBR.player.onChange. (Broadcasts from the background back to a popover
// didn't arrive reliably.)
import { OBR, SDK, ID, asset } from "./store.js?v=0.9.23";

export const AIM_START = `${ID}/aim-start`;
export const AIM_ABORT = `${ID}/aim-abort`;
export const AIM_KEY = `${ID}/aim`;

// { nonce, status: "active" | "done" | "cancel", attackerId, moveName, targetIds }
export const aimState = (player) => player?.metadata?.[AIM_KEY] ?? null;
const setAimState = (s) => OBR.player.setMetadata({ [AIM_KEY]: { ...s, at: Date.now() } });

// asks the background to start aiming; resolves the nonce, or null if it doesn't answer
// (an old cached background page, or the extension not loaded in this browser)
export async function requestAim(req) {
  const nonce = crypto.randomUUID();
  await OBR.broadcast.sendMessage(AIM_START, { ...req, nonce }, { destination: "LOCAL" });
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 120));
    const s = aimState({ metadata: await OBR.player.getMetadata() });
    if (s?.nonce === nonce) return s.status === "active" || s.status === "done" ? nonce : null;
  }
  return null;
}
export const AIM_STALE = "A parte da extensão que desenha a área não respondeu. Recarregue a página do Owlbear (F5) e tente de novo.";
const TOOL = `${ID}/aim-tool`;
const MODE = `${ID}/aim-mode`;
const COLOR = "#e3504f";

let aim = null;

// ------------------------------------------------------------------ geometry (scene pixels)

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => (len(a) ? mul(a, 1 / len(a)) : { x: 1, y: 0 });
const perp = (a) => ({ x: -a.y, y: a.x });

// polygon of the template; dir is a unit vector, L the length/radius in pixels, cell one square in pixels
function templatePolygon(shape, origin, dir, L, cell) {
  if (shape === "cone") {
    // 5e cone: as wide as it is long at the far end
    const end = add(origin, mul(dir, L));
    return [origin, add(end, mul(perp(dir), L / 2)), add(end, mul(perp(dir), -L / 2))];
  }
  if (shape === "line") {
    const w = mul(perp(dir), cell / 2); // 1 square (1,5 m) wide
    const end = add(origin, mul(dir, L));
    return [add(origin, w), add(end, w), sub(end, w), sub(origin, w)];
  }
  const n = 40;
  if (shape === "semicircle") {
    const base = Math.atan2(dir.y, dir.x);
    const pts = [origin];
    for (let i = 0; i <= n / 2; i++) {
      const a = base - Math.PI / 2 + (i / (n / 2)) * Math.PI;
      pts.push(add(origin, { x: Math.cos(a) * L, y: Math.sin(a) * L }));
    }
    return pts;
  }
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return add(origin, { x: Math.cos(a) * L, y: Math.sin(a) * L });
  });
}

function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2 || 1)));
  return len(sub(p, add(a, mul(ab, t))));
}

// a token counts when its center is inside, or it overlaps the edge by half its radius
function touches(poly, center, radius) {
  if (insidePolygon(center, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (distToSegment(center, poly[i], poly[(i + 1) % poly.length]) < radius * 0.5) return true;
  return false;
}

// ------------------------------------------------------------------ aiming

async function setup() {
  await OBR.tool.create({
    id: TOOL,
    icons: [{ icon: asset("icons/area.svg"), label: "Área do Move (PMP)" }],
    defaultMode: MODE,
  });
  await OBR.tool.createMode({
    id: MODE,
    icons: [{ icon: asset("icons/area.svg"), label: "Mirar a área", filter: { activeTools: [TOOL] } }],
    cursors: [{ cursor: "crosshair" }],
    onToolMove: (_ctx, ev) => aim && aimAt(ev.pointerPosition),
    onToolClick: (_ctx, ev) => { if (aim) confirm(ev.pointerPosition); return false; },
    onKeyDown: (_ctx, ev) => { if (aim && ev.key === "Escape") finish(false); },
    onDeactivate: () => { if (aim) finish(false); },
  });
}

async function candidates() {
  const gm = (await OBR.player.getRole()) === "GM";
  return OBR.scene.items.getItems((i) => i.type === "IMAGE" && (i.layer === "CHARACTER" || i.layer === "MOUNT") && (i.visible || gm) && !i.attachedTo);
}

function targetsIn(poly) {
  return aim.tokens.filter((t) => t.id !== aim.attacker.id && touches(poly, t.position, aim.radiusOf(t)));
}

let busy = false, queued = null;
async function aimAt(pointer) {
  if (busy) { queued = pointer; return; }
  busy = true;
  try {
    aim.pointer = pointer;
    const dir = norm(sub(pointer, aim.attacker.position));
    const poly = templatePolygon(aim.shape, aim.attacker.position, dir, aim.L, aim.cell);
    aim.targets = targetsIn(poly);
    const names = aim.targets.map((t) => t.name || "Token");
    const text = `${aim.label} · ${names.length ? `${names.length} alvo${names.length > 1 ? "s" : ""}: ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}` : "nenhum alvo"} · clique pra usar, Esc cancela`;
    await OBR.scene.local.updateItems([aim.templateId, aim.labelId], (drafts) => {
      for (const d of drafts) {
        if (d.id === aim.templateId) d.points = poly;
        else { d.position = { x: pointer.x, y: pointer.y - aim.cell * 0.4 }; d.text.plainText = text; }
      }
    });
  } finally {
    busy = false;
    if (queued) { const q = queued; queued = null; aimAt(q); }
  }
}

async function confirm(pointer) {
  await aimAt(pointer);
  finish(true);
}

async function finish(confirmed) {
  const a = aim;
  aim = null;
  if (!a) return;
  await OBR.scene.local.deleteItems([a.templateId, a.labelId]).catch(() => {});
  await setAimState({
    nonce: a.nonce,
    status: confirmed ? "done" : "cancel",
    attackerId: a.attacker.id,
    moveName: a.moveName,
    targetIds: confirmed ? a.targets.map((t) => t.id) : [],
  });
  await OBR.tool.activateTool(a.previousTool || "rodeo.owlbear.tool/move").catch(() => {});
  await OBR.tool.remove(TOOL).catch(() => {});
  await OBR.tool.removeMode(MODE).catch(() => {});
}

export { templatePolygon, touches }; // for tools/test-rules.html

export const abortAim = () => finish(false);

// tells the sheet the aim failed (so it stops waiting)
export const failAim = (req) => setAimState({ nonce: req.nonce, status: "cancel", attackerId: req.attackerId, moveName: req.moveName, targetIds: [] });

// { nonce, attackerId, moveName, shape, meters, label }
export async function startAim(req) {
  if (aim) await finish(false);
  const [attacker] = await OBR.scene.items.getItems([req.attackerId]);
  if (!attacker) throw new Error("Pokémon não encontrado na cena.");
  const [dpi, scale, oneCell] = await Promise.all([
    OBR.scene.grid.getDpi(),
    OBR.scene.grid.getScale(),
    OBR.scene.grid.getDistance({ x: 0, y: 0 }, { x: (await OBR.scene.grid.getDpi()), y: 0 }),
  ]);
  const cell = dpi / (oneCell || 1); // pixels per square, also on isometric/hex grids
  const metersPerCell = scale.parsed?.multiplier ?? 1.5;
  const sizeOf = (t) => (t.image && t.grid?.dpi ? Math.max(1, (t.image.width / t.grid.dpi) * Math.abs(t.scale?.x ?? 1)) : 1);
  const L = (req.meters / metersPerCell) * cell + (sizeOf(attacker) * cell) / 2; // measured from the token's edge

  const previousTool = await OBR.tool.getActiveTool().catch(() => null);
  const origin = attacker.position;
  const startDir = { x: 1, y: 0 };
  const poly = templatePolygon(req.shape, origin, startDir, L, cell);

  const template = SDK.buildCurve().points(poly).fillColor(COLOR).fillOpacity(0.22).strokeColor(COLOR).strokeWidth(cell * 0.04)
    .strokeOpacity(0.9).layer("POINTER").disableHit(true).build();
  template.style.closed = true;
  template.style.tension = 0;
  const label = SDK.buildLabel().plainText(`${req.label} · mova o mouse pra mirar`).position({ x: origin.x + L, y: origin.y })
    .backgroundColor("#1e2231").backgroundOpacity(0.9).fillColor("#ffffff").pointerDirection("DOWN").layer("POINTER").disableHit(true).build();

  aim = {
    nonce: req.nonce, attacker, moveName: req.moveName, shape: req.shape, label: req.label, L, cell, previousTool,
    templateId: template.id, labelId: label.id, targets: [],
    tokens: await candidates(),
    radiusOf: (t) => (sizeOf(t) * cell) / 2,
  };
  await OBR.scene.local.addItems([template, label]);
  await setup();
  await OBR.tool.activateTool(TOOL);
  await setAimState({ nonce: req.nonce, status: "active", attackerId: attacker.id, moveName: req.moveName, targetIds: [] });
  // a radius around the Pokémon doesn't need aiming: show who is inside right away
  await aimAt({ x: origin.x + 1, y: origin.y });
}
