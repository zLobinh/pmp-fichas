// Things that touch the map: distances and range, Pretty Sordid initiative, hit/miss animations.
import { OBR, SDK, ID, getSheet, pushLog, getSettings } from "./store.js?v=0.9.23";
import { fmtM } from "./rules.js?v=0.9.23";
import { getRoller } from "./dice.js?v=0.9.23";

// ------------------------------------------------------------------ distance & range

const UNIT_TO_M = { m: 1, ft: 0.3048, km: 1000, mi: 1609.34 };

// token size in grid cells (a 2x2 token is 2): the image's grid dpi = pixels per cell
function sizeCells(item) {
  if (!item.image || !item.grid?.dpi) return 1;
  return Math.max(1, Math.round((item.image.width / item.grid.dpi) * Math.abs(item.scale?.x ?? 1)));
}

// how many grid cells wide the token is: the Pokémon's height from the PMP size ("Pequeno (0,8 m)")
// over the meters of a cell (1,5 m): a 0,8 m Lycanroc ~½ square, a 9,2 m Onix ~6. Never under ⅓ of a
// square (still clickable). Without a height, the category: Miúdo ½, Pequeno/Médio 1, Grande 2...
// (the reach and range rules keep using the category, not this)
export const SIZE_CELLS = [0.5, 1, 1, 2, 3, 4];
export function heightOf(rules, pkmn) {
  const m = /([\d]+(?:[.,]\d+)?)\s*~?\s*m\b/i.exec(rules.speciesData(pkmn)?.size ?? "");
  return m ? Number(m[1].replace(",", ".")) : null;
}
export function tokenCells(rules, pkmn, cellM = 1.5) {
  const h = heightOf(rules, pkmn);
  if (!h) return SIZE_CELLS[rules.sizeRank(pkmn)] ?? 1;
  return Math.max(1 / 3, Math.round((h / cellM) * 100) / 100);
}
// in an item draft (+ its sheet): makes the image cover `cells` grid cells at scale 1, keeping the
// left/right flip; a token in the pokéball keeps its small size and gets the right one back on release
export function fitDraft(dr, cells, sheet = null) {
  const w = dr.image?.width;
  if (!w || !cells) return false;
  dr.grid = { ...(dr.grid ?? {}), dpi: w / cells, offset: dr.grid?.offset ?? { x: w / 2, y: (dr.image.height ?? w) / 2 } };
  const flip = Math.sign(dr.scale?.x ?? 1) || 1;
  if (sheet?.ball) {
    sheet.ball.scale = { x: flip, y: 1 };
    dr.scale = { x: flip * 0.35, y: 0.35 };
  } else dr.scale = { x: flip, y: 1 };
  return true;
}

// meters per grid cell (the scene's scale, in meters)
export async function cellMeters() {
  const scale = await OBR.scene.grid.getScale();
  const unit = UNIT_TO_M[scale.parsed?.unit?.toLowerCase?.()] ?? 1;
  return (scale.parsed?.multiplier ?? 1.5) * unit;
}

// how high a Pokémon is flying (sheet.battle.alt, meters)
export const altitudeOf = (item) => Math.max(0, Number(getSheet(item)?.battle?.alt) || 0);

// ground distance in meters between two points (Owlbear ruler), no token size
export async function pointMeters(p, q) {
  const [cells, m] = await Promise.all([OBR.scene.grid.getDistance(p, q), cellMeters()]);
  return cells * m;
}

// "Distância voando = maior distância (vertical ou horizontal) + metade da menor" (pág. 52)
export const flightDistance = (h, v) => Math.max(h, v) + Math.min(h, v) / 2;

// edge-to-edge distance in meters, using the scene's grid measurement (same as the Owlbear ruler),
// with the difference in altitude when one of them is flying. opts.vertical overrides that difference.
export async function distanceMeters(a, b, opts = {}) {
  const [cells, m] = await Promise.all([OBR.scene.grid.getDistance(a.position, b.position), cellMeters()]);
  const shrink = (sizeCells(a) - 1) / 2 + (sizeCells(b) - 1) / 2;
  const h = Math.max(0, cells - shrink) * m;
  const v = opts.vertical ?? Math.abs(altitudeOf(a) - altitudeOf(b));
  return v > 0 ? flightDistance(h, v) : h;
}

// [{ id, name, meters, ok, reason, jump }] for every target
// opts.jump = { height, left }: a Pokémon on the ground may jump to reach a flying one in melee
// (pág. 52 "Salto em Altura"; the jump uses movement)
export async function checkRange(attacker, move, targets, opts = {}) {
  const r = move.rangeInfo;
  const out = [];
  for (const t of targets) {
    if (r.kind === "any") { out.push({ id: t.id, name: t.name, ok: true }); continue; }
    if (r.kind === "self") {
      out.push({ id: t.id, name: t.name, ok: t.id === attacker.id, reason: "move pessoal (só no próprio Pokémon)" });
      continue;
    }
    const v = Math.abs(altitudeOf(attacker) - altitudeOf(t));
    // melee reaches 1,5 m up or down without jumping
    const reachV = r.kind === "melee" ? Math.max(0, v - 1.5) : v;
    const meters = Math.round((await distanceMeters(attacker, t, { vertical: reachV })) * 10) / 10;
    let ok = meters <= r.meters + 0.05;
    let reason = ok ? "" : `está a ${fmtM(meters)}${v ? ` (${fmtM(v)} de altura)` : ""}, alcance ${r.label}`;
    let jump = null;
    if (!ok && r.kind === "melee" && opts.jump && altitudeOf(t) > altitudeOf(attacker) && altitudeOf(attacker) === 0) {
      const need = Math.round(reachV * 10) / 10;
      const jumped = Math.round((await distanceMeters(attacker, t, { vertical: Math.max(0, reachV - opts.jump.height) })) * 10) / 10;
      if (jumped <= r.meters + 0.05 && need <= opts.jump.height + 0.05) {
        if (opts.jump.left != null && opts.jump.left + 0.05 < need) reason = `precisa pular ${fmtM(need)} e só tem ${fmtM(opts.jump.left)} de deslocamento`;
        else { ok = true; jump = need; reason = ""; }
      } else reason = `está a ${fmtM(v)} de altura: o pulo alcança só ${fmtM(Math.round((opts.jump.height + 1.5) * 10) / 10)}`;
    }
    out.push({ id: t.id, name: t.name, meters, ok, reason, jump });
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
  const sheet = getSheet(item);
  const pkmn = sheet.pkmn;
  // Velocidade: + stage x proficiency (pág. 73)
  // abilities and weather: Swift Swim, Chlorophyll, Sand Rush, Slush Rush, Unburden (+2× prof.),
  // Quick Feet (×1,5, ignores paralysis), Slow Start (½), Stall (always last)
  const { initiativeMods } = await import("./abilities.js?v=0.9.23");
  const { fieldNow } = await import("./field.js?v=0.9.23");
  const im = initiativeMods(rules, sheet, await fieldNow(null, null, item).catch(() => ({})));
  const bonus = rules.initiative(pkmn) + (pkmn.stages?.Speed ?? 0) * rules.proficiency(pkmn) + im.add;
  const settings = await getSettings();
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  const { nat: natRoll } = await roller.d20(bonus, `${item.name || rules.name(pkmn)} iniciativa`);
  const nat = natRoll;
  // Paralisado: initiative value halved (pág. 72)
  const paralyzed = !!(sheet.battle?.cond?.Paralyzed || pkmn.statuses?.Paralyzed) && !im.ignoreParalysis;
  let total = Math.floor((paralyzed ? Math.floor((nat + bonus) / 2) : nat + bonus) * im.mult);
  if (im.stall) {
    // Stall: the lowest initiative in the fight − 1
    const counts = (await OBR.scene.items.getItems((i) => i.id !== item.id && typeof i.metadata?.[PRETTY_KEY]?.count === "string")).map((i) => parseFloat(i.metadata[PRETTY_KEY].count) || 0);
    if (counts.length) total = Math.min(...counts) - 1;
  }
  await setInitiative(item.id, total);
  const label = ["Iniciativa", paralyzed ? "paralisado, metade" : null, ...im.notes, im.stall ? "Stall: por último" : null].filter(Boolean);
  const entry = { kind: "check", attacker: item.name || rules.name(pkmn), label: label.length > 1 ? `${label[0]} (${label.slice(1).join(", ")})` : label[0], nat, bonus, total, roller: roller.name };
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

const FX_COLOR = { hit: "#ef5d5d", crit: "#f0b03f", miss: "#9aa0b8", heal: "#46c37b" };
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
