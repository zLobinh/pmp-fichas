import { OBR, ID, SHEET_KEY, loadRules, parseExport, syncTheme } from "./store.js?v=0.9.20";
import { fitDraft, tokenCells, cellMeters } from "./map.js?v=0.9.20";

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
    // a player's Pokémon join the players' team; the GM picks (enemies by default)
    const gm = (await OBR.player.getRole()) === "GM";
    const team = gm ? $("team").value : "jogadores";
    const cellM = await cellMeters();
    let again = false;
    await OBR.scene.items.updateItems([itemId], (drafts) => {
      for (const d of drafts) {
        const old = d.metadata[SHEET_KEY];
        if (old?.pkmn) {
          // reimport: the new sheet, keeping who owns it, the team, the trainer, the pokéball and the battle
          again = true;
          old.pkmn = pkmn;
          old.imported = Date.now();
        } else d.metadata[SHEET_KEY] = { pkmn, owner: OBR.player.id, team, imported: Date.now() };
        // (under an Illusion the name/size are the disguise's: leave them)
        if ($("rename").checked && !old?.realLook) d.name = name;
        if ($("resize").checked && !old?.realLook) fitDraft(d, tokenCells(rules, pkmn, cellM), d.metadata[SHEET_KEY]);
      }
    });
    OBR.notification.show(`Ficha de ${name} (nível ${rules.level(pkmn)}) ${again ? "atualizada (equipe, dono e batalha mantidos)" : "importada"}!`, "SUCCESS");
    await close();
  } catch (e) {
    showError(e.message ?? String(e));
  } finally {
    button.disabled = false;
    button.textContent = "Importar";
  }
};

ready.then(async () => {
  syncTheme();
  // (reimport: the team stays the one the token already has)
  if ((await OBR.player.getRole()) === "GM" && !new URLSearchParams(location.search).get("re")) $("teamRow").style.display = "";
}).catch(() => {});
