// Escolher no mapa onde um Pokémon aparece (um clique):
//  - no início de uma batalha preparada, cada lado marca onde cada inicial sai (dentro da arena). A marca só
//    aparece pra quem marcou (item local do Owlbear) e fica no prep, que o popup dos outros não mostra;
//  - no meio da luta, quem entra depois de um nocaute (liberar, ou trocar o desmaiado) sai onde o jogador
//    clicar, a até 9 m do treinador. (Troca normal: no lugar de quem saiu, sem perguntar.)
// O popup só PEDE (broadcast local); a ferramenta e a ação rodam aqui no background, que fica sempre aberto
// (o popup pode fechar quando a pessoa clica no mapa).
import { OBR, SDK, ID, asset, loadRules, getSheet, pushLog } from "./store.js?v=0.9.28";

export const PLACE = `${ID}/place`;
export const SPOT_MARK = `${ID}/spotMark`;
export const ENTRY_RANGE = 9; // m do treinador, ao entrar depois de um nocaute
const TOOL = `${ID}/place-tool`, MODE = `${ID}/place-mode`, GUIDE = `${ID}/placeGuide`;

// from a popup: { action: "prep" | "release" | "switch", label, pokemonId, trainerId, fromId, opts, center, maxM, arena }
export const requestPlace = (data) => OBR.broadcast.sendMessage(PLACE, data, { destination: "LOCAL" });

async function guide(data) {
  if (!data.center || !data.maxM) return;
  const { cellMeters } = await import("./map.js?v=0.9.28");
  const dpi = await OBR.scene.grid.getDpi();
  const d = ((2 * data.maxM) / (await cellMeters())) * dpi;
  const ring = SDK.buildShape().shapeType("CIRCLE").width(d).height(d).position({ ...data.center })
    .fillColor("#38bdf8").fillOpacity(0.08).strokeColor("#38bdf8").strokeOpacity(0.9).strokeWidth(Math.max(2, dpi * 0.03))
    .layer("DRAWING").locked(true).disableHit(true).metadata({ [GUIDE]: true }).build();
  await OBR.scene.local.addItems([ring]).catch(() => {});
}
async function clearGuide() {
  const old = await OBR.scene.local.getItems((i) => !!i.metadata?.[GUIDE]).catch(() => []);
  if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id)).catch(() => {});
}

// the starters' marks of this player (only they see them)
export async function clearSpotMarks(pokemonId = null) {
  const old = await OBR.scene.local.getItems((i) => !!i.metadata?.[SPOT_MARK] && (!pokemonId || i.metadata[SPOT_MARK].pokemonId === pokemonId)).catch(() => []);
  if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id)).catch(() => {});
}
async function spotMark(pos, pokemonId, name) {
  await clearSpotMarks(pokemonId);
  const dpi = await OBR.scene.grid.getDpi();
  const ring = SDK.buildShape().shapeType("CIRCLE").width(dpi * 0.9).height(dpi * 0.9).position({ ...pos })
    .fillColor("#f59e0b").fillOpacity(0.18).strokeColor("#f59e0b").strokeOpacity(0.95).strokeWidth(Math.max(2, dpi * 0.04))
    .layer("DRAWING").locked(true).disableHit(true).metadata({ [SPOT_MARK]: { pokemonId } }).build();
  const label = SDK.buildLabel().plainText(`📍 ${name}`).position({ x: pos.x, y: pos.y + dpi * 0.55 })
    .backgroundColor("#1e2231").backgroundOpacity(0.85).fillColor("#ffffff").pointerDirection("UP")
    .layer("TEXT").locked(true).disableHit(true).metadata({ [SPOT_MARK]: { pokemonId } }).build();
  await OBR.scene.local.addItems([ring, label]).catch(() => {});
}

// what happens on the click
async function run(data, pos) {
  const rules = await loadRules();
  const T = await import("./trainer.js?v=0.9.28");
  if (data.action === "prep") {
    const { setPrep } = await import("./prep.js?v=0.9.28");
    await setPrep((x) => {
      const e = x?.trainers?.[data.trainerId];
      if (!e || x.status !== "setup") return x;
      e.spots = { ...(e.spots ?? {}), [data.pokemonId]: { x: pos.x, y: pos.y } };
      return x;
    });
    await spotMark(pos, data.pokemonId, data.label ?? "");
    return;
  }
  const [trainer] = await OBR.scene.items.getItems([data.trainerId]);
  if (!trainer) throw new Error("O treinador não está mais no mapa.");
  if (data.action === "release") {
    const [p] = await OBR.scene.items.getItems([data.pokemonId]);
    if (!p) return;
    await T.releaseIntoFight(rules, p, trainer, pos);
  } else if (data.action === "switch") {
    const [from, to] = await OBR.scene.items.getItems([data.fromId, data.pokemonId]).then((l) => [l.find((i) => i.id === data.fromId), l.find((i) => i.id === data.pokemonId)]);
    if (!from || !to) return;
    await T.switchPokemon(rules, from, to, { ...(data.opts ?? {}), pos });
  }
}

export function watchPlacing() {
  OBR.broadcast.onMessage(PLACE, async ({ data }) => {
    const prevTool = await OBR.tool.getActiveTool().catch(() => null);
    await clearGuide();
    const done = async () => {
      await clearGuide();
      await OBR.tool.activateTool(prevTool && prevTool !== TOOL ? prevTool : "rodeo.owlbear.tool/move").catch(() => {});
      await OBR.tool.remove(TOOL).catch(() => {});
      await OBR.tool.removeMode(MODE).catch(() => {});
    };
    await OBR.tool.remove(TOOL).catch(() => {});
    await OBR.tool.removeMode(MODE).catch(() => {});
    await OBR.tool.create({ id: TOOL, icons: [{ icon: asset("icons/pokeball.svg"), label: "Onde o Pokémon sai" }], defaultMode: MODE });
    await OBR.tool.createMode({
      id: MODE,
      icons: [{ icon: asset("icons/pokeball.svg"), label: "Clique onde o Pokémon sai", filter: { activeTools: [TOOL] } }],
      cursors: [{ cursor: "crosshair" }],
      onToolClick: async (_ctx, ev) => {
        let p = ev.pointerPosition;
        p = await OBR.scene.grid.snapPosition(p).catch(() => p);
        if (data.center && data.maxM) {
          const { pointMeters } = await import("./map.js?v=0.9.28");
          const dm = await pointMeters(data.center, p);
          if (dm > data.maxM + 0.05) { OBR.notification.show(`Longe demais do treinador (${Math.round(dm * 10) / 10} m; máximo ${data.maxM} m).`, "WARNING"); return false; }
        }
        if (data.arena) {
          const { inArena } = await import("./prep.js?v=0.9.28");
          if (!inArena(data.arena, p)) { OBR.notification.show("Tem que ser dentro da arena.", "WARNING"); return false; }
        }
        await done();
        try { await run(data, p); } catch (e) { OBR.notification.show(e.message, "ERROR"); }
        return false;
      },
      onKeyDown: async (_ctx, ev) => { if (ev.key === "Escape") { await done(); OBR.notification.show("Escolha do local cancelada.", "INFO"); } },
    });
    await OBR.tool.activateTool(TOOL);
    await guide(data);
    OBR.notification.show(`Clique no mapa onde ${data.label ?? "o Pokémon"} vai sair${data.maxM ? ` (até ${data.maxM} m do treinador)` : data.arena ? " (dentro da arena)" : ""}. Esc cancela.`, "INFO");
  });
}
