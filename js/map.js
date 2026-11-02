// Things that touch the map: distances and range, Pretty Sordid initiative, hit/miss animations.
import { OBR, SDK, ID, getSheet, pushLog, getSettings } from "./store.js?v=0.5.0";
import { fmtM } from "./rules.js?v=0.5.0";
import { getRoller } from "./dice.js?v=0.5.0";

// ------------------------------------------------------------------ distance & range

const UNIT_TO_M = { m: 1, ft: 0.3048, km: 1000, mi: 1609.34 };

// token size in grid cells (a 2x2 token is 2): the image's grid dpi = pixels per cell
function sizeCells(item) {
  if (!item.image || !item.grid?.dpi) return 1;
  return Math.max(1, Math.round((item.image.width / item.grid.dpi) * Math.abs(item.scale?.x ?? 1)));
}

// edge-to-edge distance in meters, using the scene's grid measurement (same as the Owlbear ruler)
export async function distanceMeters(a, b) {
  const [cells, scale] = await Promise.all([
    OBR.scene.grid.getDistance(a.position, b.position),
    OBR.scene.grid.getScale(),
  ]);
  const shrink = (sizeCells(a) - 1) / 2 + (sizeCells(b) - 1) / 2;
  const unit = UNIT_TO_M[scale.parsed?.unit?.toLowerCase?.()] ?? 1;
  return Math.max(0, cells - shrink) * (scale.parsed?.multiplier ?? 1.5) * unit;
}

// [{ id, name, meters, ok, reason }] for every target
export async function checkRange(attacker, move, targets) {
  const r = move.rangeInfo;
  const out = [];
  for (const t of targets) {
    if (r.kind === "any") { out.push({ id: t.id, name: t.name, ok: true }); continue; }
    if (r.kind === "self") {
      out.push({ id: t.id, name: t.name, ok: t.id === attacker.id, reason: "move pessoal (só no próprio Pokémon)" });
      continue;
    }
    const meters = Math.round((await distanceMeters(attacker, t)) * 10) / 10;
    const ok = meters <= r.meters + 0.05;
    out.push({ id: t.id, name: t.name, meters, ok, reason: ok ? "" : `está a ${fmtM(meters)}, alcance ${r.label}` });
  }
  return out;
}

export class OutOfRange extends Error {
  constructor(list) {
    super(`Fora do alcance: ${list.map((x) => `${x.name} (${x.reason})`).join("; ")}`);
    this.list = list;
  }
}

// ------------------------------------------------------------------ Pretty Sordid initiative

export const PRETTY_KEY = "com.pretty-initiative/metadata";

export const initiativeOf = (item) => {
  const m = item?.metadata?.[PRETTY_KEY];
  return m && typeof m.count === "string" ? { count: m.count, active: m.active === true } : null;
};

// writes the count where Pretty Sordid reads it, then re-sorts its order like its own sortList()
export async function setInitiative(itemId, total) {
  await OBR.scene.items.updateItems([itemId], (drafts) => {
    for (const dr of drafts) {
      const prev = dr.metadata[PRETTY_KEY];
      if (prev && typeof prev === "object") prev.count = String(total);
      else dr.metadata[PRETTY_KEY] = { count: String(total), active: false };
    }
  });
  const ascending = (await OBR.room.getMetadata())["com.pretty-initiative/sortAscending"] === true;
  const items = await OBR.scene.items.getItems((i) => typeof i.metadata[PRETTY_KEY]?.count === "string");
  const n = (i) => parseFloat(i.metadata[PRETTY_KEY].count) || 0;
  items.sort((a, b) => (ascending ? n(a) - n(b) : n(b) - n(a)));
  await OBR.scene.setMetadata({ "com.pretty-initiative/order": Object.fromEntries(items.map((it, i) => [i, it.id])) });
}

export async function rollInitiative(rules, item) {
  const pkmn = getSheet(item).pkmn;
  const bonus = rules.initiative(pkmn);
  const settings = await getSettings();
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  const { nat } = await roller.d20(bonus, `${item.name || rules.name(pkmn)} iniciativa`);
  const total = nat + bonus;
  await setInitiative(item.id, total);
  const entry = { kind: "check", attacker: item.name || rules.name(pkmn), label: "Iniciativa", nat, bonus, total, roller: roller.name };
  await pushLog(entry);
  return entry;
}

// ------------------------------------------------------------------ hit/miss animation on the map

export const FX_CHANNEL = `${ID}/fx`;

// everyone (including the roller) plays the animation from this message
export async function sendFx(attacker, entry, targets) {
  const hits = entry.results
    .filter((r) => r.targetId)
    .map((r) => {
      const t = targets.find((x) => x.id === r.targetId);
      if (!t) return null;
      const miss = r.attack && !r.attack.hit;
      const kind = miss ? "miss" : r.attack?.crit ? "crit" : "hit";
      let text = miss ? "Errou" : r.damage ? `-${r.damage.final}` : r.save ? (r.save.success ? "Passou" : "Falhou") : "Acertou";
      if (kind === "crit") text = `CRÍTICO ${text}`;
      if (r.damage?.eff === 0) text = "Imune";
      return { to: t.position, kind, text };
    })
    .filter(Boolean);
  if (!hits.length) return;
  await OBR.broadcast.sendMessage(FX_CHANNEL, { from: attacker.position, hits }, { destination: "ALL" });
}

const FX_COLOR = { hit: "#ef5d5d", crit: "#f0b03f", miss: "#9aa0b8" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function playFx({ from, hits }) {
  const dpi = await OBR.scene.grid.getDpi();
  const lines = [], rings = [], labels = [];
  for (const h of hits) {
    const color = FX_COLOR[h.kind];
    lines.push(SDK.buildLine().startPosition(from).endPosition(h.to).strokeColor(color).strokeWidth(dpi * 0.06)
      .strokeOpacity(0.85).strokeDash(h.kind === "miss" ? [dpi * 0.2, dpi * 0.15] : []).layer("POINTER").disableHit(true).build());
    rings.push(SDK.buildShape().shapeType("CIRCLE").width(dpi * 0.6).height(dpi * 0.6).position(h.to).fillOpacity(0)
      .strokeColor(color).strokeWidth(dpi * 0.08).strokeOpacity(0.9).layer("POINTER").disableHit(true).build());
    labels.push(SDK.buildLabel().plainText(h.text).position({ x: h.to.x, y: h.to.y - dpi * 0.55 }).backgroundColor(color)
      .backgroundOpacity(0.95).fillColor("#ffffff").fontWeight(700).pointerDirection("DOWN").layer("POINTER").disableHit(true).build());
  }
  const all = [...lines, ...rings, ...labels];
  await OBR.scene.local.addItems(all);
  // ~1s: the ring opens up and the label floats up, then everything fades
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await wait(70);
    const k = i / steps;
    await OBR.scene.local.updateItems([...rings, ...labels].map((x) => x.id), (drafts) => {
      for (const dr of drafts) {
        const ring = rings.findIndex((r) => r.id === dr.id);
        if (ring >= 0) {
          dr.width = dpi * (0.6 + 0.7 * k);
          dr.height = dpi * (0.6 + 0.7 * k);
          dr.style.strokeOpacity = 0.9 * (1 - k * 0.7);
        } else {
          const j = labels.findIndex((l) => l.id === dr.id);
          dr.position = { x: hits[j].to.x, y: hits[j].to.y - dpi * (0.55 + 0.35 * k) };
        }
      }
    });
  }
  await wait(1100);
  await OBR.scene.local.deleteItems(all.map((x) => x.id));
}
