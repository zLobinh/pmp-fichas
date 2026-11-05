// Context menu entries on tokens, the quick sheet on selection, and notifications for everyone's rolls.
import { OBR, ID, SHEET_KEY, LOG_CHANNEL, asset, getSheet, canEdit } from "./store.js?v=0.9.1";
import { describe } from "./combat.js?v=0.9.1";
import { openSheet, openHud, autoHudEnabled, hudAlive, markHudAlive } from "./ui.js?v=0.9.1";
import { FX_CHANNEL, playFx } from "./map.js?v=0.9.1";
import { AIM_START, AIM_ABORT, startAim, abortAim, failAim } from "./area.js?v=0.9.1";
import { watchTurns, watchMarks } from "./battle.js?v=0.9.1";
import { watchMovement, TOAST } from "./tactics.js?v=0.9.1";
import { runPrepared } from "./prepared.js?v=0.9.1";
import { loadRules } from "./store.js?v=0.9.1";

let lastSelection = "";
let viewer = { id: null, role: "PLAYER" }; // hides enemy AC/HP from players in the notifications

// selecting one Pokémon you control opens the quick sheet (an open one follows the selection itself)
async function onSelection(selection) {
  const key = (selection ?? []).join(",");
  if (key === lastSelection) return; // player.onChange also fires for metadata changes
  lastSelection = key;
  if (!autoHudEnabled() || !selection || selection.length !== 1 || hudAlive()) return;
  const [item] = await OBR.scene.items.getItems(selection);
  const sheet = getSheet(item);
  if (!sheet || !(await canEdit(sheet))) return;
  markHudAlive(); // until the new popover starts its own heartbeat
  await openHud(item.id);
}

OBR.onReady(() => {
  OBR.contextMenu.create({
    id: `${ID}/open`,
    icons: [
      {
        icon: asset("icons/pokeball.svg"),
        label: "Ficha PMP",
        filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
      },
    ],
    onClick: (context, elementId) => openSheet(context.items[0].id, elementId),
  });

  OBR.contextMenu.create({
    id: `${ID}/quick`,
    icons: [
      {
        icon: asset("icons/area.svg"),
        label: "Ficha rápida (HP e moves)",
        filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
      },
    ],
    onClick: async (context, elementId) => {
      const item = context.items[0];
      // each player controls only their own Pokémon; anyone else's opens the (limited) sheet
      if (!(await canEdit(getSheet(item)))) return openSheet(item.id, elementId);
      markHudAlive();
      openHud(item.id);
    },
  });

  OBR.contextMenu.create({
    id: `${ID}/import`,
    icons: [
      {
        icon: asset("icons/import.svg"),
        label: "Importar ficha do PMP",
        filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined }] },
      },
    ],
    onClick: (context) =>
      OBR.modal.open({
        id: `${ID}/import`,
        url: asset(`import.html?id=${encodeURIComponent(context.items[0].id)}`),
        width: 480,
        height: 430,
      }),
  });

  OBR.player.onChange((player) => onSelection(player.selection));
  OBR.broadcast.onMessage(`${ID}/hud-closed`, () => markHudAlive(false));

  OBR.broadcast.onMessage(FX_CHANNEL, ({ data }) => { playFx(data).catch(() => {}); });
  OBR.broadcast.onMessage(AIM_START, ({ data }) => {
    startAim(data).catch((e) => {
      OBR.notification.show(`Erro ao mirar a área: ${e.message}`, "ERROR");
      abortAim().catch(() => {});
      failAim(data).catch(() => {});
    });
  });
  OBR.broadcast.onMessage(AIM_ABORT, () => { abortAim().catch(() => {}); });

  // turn start/end effects and token marks run on ONE browser: the GM's
  OBR.player.getRole().then(async (role) => {
    viewer = { id: OBR.player.id, role };
    if (role !== "GM") return;
    const rules = await loadRules();
    const start = () => {
      watchTurns(rules, { onTurnStart: (item) => runPrepared(rules, item) });
      watchMarks(rules);
      watchMovement(rules);
    };
    if (await OBR.scene.isReady()) start();
    else {
      const off = OBR.scene.onReadyChange((ready) => { if (ready) { off(); start(); } });
    }
  });

  // an attack of opportunity offered to one of MY Pokémon: warn and open its quick sheet
  // (the GM answers for Pokémon whose owner is not a player in the room)
  const seenOa = new Map();
  OBR.scene.items.onChange(async (items) => {
    for (const it of items) {
      const s = getSheet(it);
      const oa = s?.battle?.oa;
      if (!oa || seenOa.get(it.id) === oa.at) continue;
      seenOa.set(it.id, oa.at);
      if (Date.now() - oa.at > 15000) continue;
      const players = await OBR.party.getPlayers().catch(() => []);
      const ownerHere = players.some((p) => p.id === s.owner);
      const mine = s.owner === viewer.id || (viewer.role === "GM" && !ownerHere);
      if (!mine) continue;
      OBR.notification.show(`⚔ ${it.name} pode fazer um ataque de oportunidade em ${oa.targetName}`, "WARNING");
      markHudAlive();
      openHud(it.id);
    }
  });

  // movement warnings (token sent back): for the owner and the GM
  OBR.broadcast.onMessage(TOAST, ({ data }) => {
    if (viewer.role === "GM" || data.owner === viewer.id) OBR.notification.show(data.text, "WARNING");
  });

  OBR.broadcast.onMessage(LOG_CHANNEL, ({ data }) => {
    const text = describe(data, viewer);
    OBR.notification.show(text.length > 220 ? text.slice(0, 217) + "…" : text, "INFO");
  });
});
