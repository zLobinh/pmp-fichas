import { OBR, ID, SHEET_KEY, loadRules, parseExport, syncTheme } from "./store.js";

const itemId = new URLSearchParams(location.search).get("id");
const $ = (id) => document.getElementById(id);
const close = () => OBR.modal.close(`${ID}/import`);

OBR.onReady(async () => {
  syncTheme();
  $("close").onclick = close;
  $("cancel").onclick = close;
  $("code").focus();
  const rules = await loadRules();

  $("ok").onclick = async () => {
    $("err").textContent = "";
    try {
      const pkmn = parseExport($("code").value, rules);
      const name = rules.name(pkmn);
      await OBR.scene.items.updateItems([itemId], (drafts) => {
        for (const d of drafts) {
          d.metadata[SHEET_KEY] = { pkmn, owner: OBR.player.id, imported: Date.now() };
          if ($("rename").checked) d.name = name;
        }
      });
      OBR.notification.show(`Ficha de ${name} (nível ${rules.level(pkmn)}) importada!`, "SUCCESS");
      close();
    } catch (e) {
      $("err").textContent = e.message;
    }
  };
});
