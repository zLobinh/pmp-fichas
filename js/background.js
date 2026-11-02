// Context menu entries on tokens, the quick sheet on selection, and notifications for everyone's rolls.
import { OBR, ID, SHEET_KEY, LOG_CHANNEL, asset, getSheet, canEdit } from "./store.js?v=0.3.0";
import { describe } from "./combat.js?v=0.3.0";
import { openSheet, openHud, autoHudEnabled } from "./ui.js?v=0.3.0";
import { FX_CHANNEL, playFx } from "./map.js?v=0.3.0";

let hudOpen = false;

async function onSelection(selection) {
  if (hudOpen || !autoHudEnabled() || !selection || selection.length !== 1) return;
  const [item] = await OBR.scene.items.getItems(selection);
  const sheet = getSheet(item);
  if (!sheet || !(await canEdit(sheet))) return;
  hudOpen = true;
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
  OBR.broadcast.onMessage(`${ID}/hud-closed`, () => { hudOpen = false; });
  OBR.scene.onReadyChange((ready) => { if (!ready) hudOpen = false; });

  OBR.broadcast.onMessage(FX_CHANNEL, ({ data }) => { playFx(data).catch(() => {}); });

  OBR.broadcast.onMessage(LOG_CHANNEL, ({ data }) => {
    const text = describe(data);
    OBR.notification.show(text.length > 220 ? text.slice(0, 217) + "…" : text, "INFO");
  });
});
