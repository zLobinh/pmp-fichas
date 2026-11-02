// Action popover: Pokémon in the scene, combat log and table settings.
import { OBR, ID, LOG_KEY, SHEET_KEY, loadRules, getSheet, getSettings, setSettings, h, syncTheme, asset } from "./store.js";
import { describe } from "./combat.js";

const root = document.getElementById("root");
const state = { rules: null, items: [], log: [], settings: {}, role: "PLAYER" };

const time = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function render() {
  const { rules } = state;
  const withSheet = state.items.filter((i) => getSheet(i));
  root.replaceChildren(...[
    h("div", { class: "card" },
      h("h2", {}, `Pokémon na cena (${withSheet.length})`),
      withSheet.length
        ? withSheet.map((i) => {
            const p = getSheet(i).pkmn;
            const max = rules.maxHP(p);
            return h("div", { class: "row", style: "margin:3px 0" },
              h("span", {}, i.name || rules.name(p)),
              h("span", { class: "muted small" }, `Nv ${rules.level(p)} · HP ${p.hp.current}/${max}`),
              h("span", { class: "spacer" }),
              h("button", { onclick: () => openSheet(i.id) }, "Ficha"));
          })
        : h("div", { class: "muted small" }, "Nenhum token com ficha. Clique num token e use \"Importar ficha do PMP\".")),
    h("div", { class: "card log" },
      h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Registro"), h("span", { class: "spacer" }),
        state.role === "GM" && state.log.length ? h("button", { class: "small", onclick: () => OBR.scene.setMetadata({ [LOG_KEY]: [] }) }, "Limpar") : null),
      state.log.length
        ? h("ul", {}, state.log.map((e) => h("li", {}, h("span", { class: "muted small" }, `${time(e.at)} · ${e.by} `), describe(e))))
        : h("div", { class: "muted small", style: "margin-top:6px" }, "Nada rolado ainda nesta cena.")),
    state.role === "GM"
      ? h("div", { class: "card" },
          h("h2", {}, "Configurações da mesa"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.autoDamage, onchange: (e) => setSettings({ autoDamage: e.target.checked }) }), "Descontar o dano do HP do alvo automaticamente"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.autoPP, onchange: (e) => setSettings({ autoPP: e.target.checked }) }), "Gastar 1 PP ao usar um Move"))
      : null,
    h("div", { class: "card small muted" },
      h("h2", {}, "Como usar"),
      h("div", {}, "1. No app, exporte o Pokémon (copia o código)."),
      h("div", {}, "2. Clique no token → \"Importar ficha do PMP\" → cole."),
      h("div", {}, "3. Clique no token → \"Ficha PMP\". Selecione os alvos no mapa e clique em Usar num Move.")),
  ].filter(Boolean));
}

async function openSheet(itemId) {
  await OBR.player.select([itemId], true);
  await OBR.popover.open({
    id: `${ID}/sheet`,
    url: asset(`sheet.html?id=${encodeURIComponent(itemId)}`),
    width: 400,
    height: 620,
    anchorOrigin: { horizontal: "LEFT", vertical: "TOP" },
    anchorPosition: { left: 70, top: 70 },
    anchorReference: "POSITION",
    disableClickAway: true,
  });
}

OBR.onReady(async () => {
  syncTheme();
  state.rules = await loadRules();
  state.role = await OBR.player.getRole();
  state.settings = await getSettings();
  const load = async () => {
    if (!(await OBR.scene.isReady())) { state.items = []; state.log = []; return render(); }
    state.items = await OBR.scene.items.getItems((i) => i.metadata[SHEET_KEY] != null);
    state.log = (await OBR.scene.getMetadata())[LOG_KEY] ?? [];
    render();
  };
  await load();
  OBR.scene.onReadyChange(load);
  OBR.scene.items.onChange((items) => { state.items = items.filter((i) => i.metadata[SHEET_KEY] != null); render(); });
  OBR.scene.onMetadataChange((meta) => { state.log = meta[LOG_KEY] ?? []; render(); });
  OBR.room.onMetadataChange(async () => { state.settings = await getSettings(); render(); });
});
