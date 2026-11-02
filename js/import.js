import { OBR, ID, SHEET_KEY, loadRules, parseExport, syncTheme } from "./store.js?v=0.5.0";

const itemId = new URLSearchParams(location.search).get("id");
const $ = (id) => document.getElementById(id);
const showError = (msg) => { $("err").textContent = msg; };
const ready = new Promise((resolve) => OBR.onReady(resolve));
const close = async () => { await ready; OBR.modal.close(`${ID}/import`); };

// any failure shows up in the window instead of failing silently
window.addEventListener("error", (e) => showError(`Erro: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => showError(`Erro: ${e.reason?.message ?? e.reason}`));

// handlers are attached right away; the work waits for Owlbear and the data inside the click
const rulesPromise = loadRules();
$("close").onclick = close;
$("cancel").onclick = close;
$("code").focus();

$("ok").onclick = async () => {
  const button = $("ok");
  showError("");
  button.disabled = true;
  button.textContent = "Importando…";
  try {
    const slow = setTimeout(() => showError("Ainda carregando os dados do PMP…"), 1500);
    const [rules] = await Promise.all([rulesPromise, ready]);
    clearTimeout(slow);
    showError("");
    const pkmn = parseExport($("code").value, rules);
    const name = rules.name(pkmn);
    if (!itemId) throw new Error("Token não encontrado. Feche e abra de novo pelo menu do token.");
    await OBR.scene.items.updateItems([itemId], (drafts) => {
      for (const d of drafts) {
        d.metadata[SHEET_KEY] = { pkmn, owner: OBR.player.id, imported: Date.now() };
        if ($("rename").checked) d.name = name;
      }
    });
    OBR.notification.show(`Ficha de ${name} (nível ${rules.level(pkmn)}) importada!`, "SUCCESS");
    await close();
  } catch (e) {
    showError(e.message ?? String(e));
  } finally {
    button.disabled = false;
    button.textContent = "Importar";
  }
};

ready.then(() => syncTheme()).catch(() => {});
