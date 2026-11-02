// Context menu entries on tokens + notifications for everyone's rolls.
import { OBR, ID, SHEET_KEY, LOG_CHANNEL, asset } from "./store.js";
import { describe } from "./combat.js";

const SHEET_POPOVER = `${ID}/sheet`;

export function openSheet(itemId, anchorElementId) {
  return OBR.popover.open({
    id: SHEET_POPOVER,
    url: asset(`sheet.html?id=${encodeURIComponent(itemId)}`),
    width: 400,
    height: 620,
    anchorElementId,
    anchorOrigin: { horizontal: "RIGHT", vertical: "CENTER" },
    transformOrigin: { horizontal: "LEFT", vertical: "CENTER" },
    disableClickAway: true, // the player clicks targets on the map while it stays open
  });
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

  OBR.broadcast.onMessage(LOG_CHANNEL, ({ data }) => {
    const text = describe(data);
    OBR.notification.show(text.length > 220 ? text.slice(0, 217) + "…" : text, "INFO");
  });
});
