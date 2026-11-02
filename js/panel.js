// Action popover: Pokémon in the scene, combat log and table settings.
import { OBR, ID, LOG_KEY, SHEET_KEY, loadRules, getSheet, getSettings, setSettings, h, syncTheme, asset } from "./store.js?v=0.5.2";
import { describe } from "./combat.js?v=0.5.2";
import { openSheet, openHud, autoHudEnabled, setAutoHud } from "./ui.js?v=0.5.2";
import { rollInitiative, initiativeOf } from "./map.js?v=0.5.2";
import { dicePlusReady } from "./dice.js?v=0.5.2";

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
            const init = initiativeOf(i);
            return h("div", { class: "row", style: "margin:3px 0" },
              h("span", { class: init?.active ? "ok" : "" }, `${init?.active ? "▶ " : ""}${i.name || rules.name(p)}`),
              h("span", { class: "muted small" }, `Nv ${rules.level(p)} · HP ${p.hp.current}/${max}${init ? ` · Init ${init.count}` : ""}`),
              h("span", { class: "spacer" }),
              h("button", { title: "Ficha rápida (HP e moves)", onclick: () => OBR.player.select([i.id], true).then(() => openHud(i.id)) }, "Rápida"),
              h("button", { onclick: () => OBR.player.select([i.id], true).then(() => openSheet(i.id)) }, "Ficha"));
          })
        : h("div", { class: "muted small" }, "Nenhum token com ficha. Clique num token e use \"Importar ficha do PMP\".")),
    h("div", { class: "card log" },
      h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Registro"), h("span", { class: "spacer" }),
        state.role === "GM" && state.log.length ? h("button", { class: "small", onclick: () => OBR.scene.setMetadata({ [LOG_KEY]: [] }) }, "Limpar") : null),
      state.log.length
        ? h("ul", {}, state.log.map((e) => h("li", {}, h("span", { class: "muted small" }, `${time(e.at)} · ${e.by} `), describe(e))))
        : h("div", { class: "muted small", style: "margin-top:6px" }, "Nada rolado ainda nesta cena.")),
    h("div", { class: "card" },
      h("h2", {}, "Minhas preferências"),
      h("label", { class: "row small" }, h("input", { type: "checkbox", checked: autoHudEnabled(), onchange: (e) => setAutoHud(e.target.checked) }), "Abrir a ficha rápida ao selecionar um Pokémon")),
    state.role === "GM"
      ? h("div", { class: "card" },
          h("h2", {}, "Configurações da mesa"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.autoDamage, onchange: (e) => setSettings({ autoDamage: e.target.checked }) }), "Descontar o dano do HP do alvo automaticamente"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.autoPP, onchange: (e) => setSettings({ autoPP: e.target.checked }) }), "Gastar 1 PP ao usar um Move"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.checkRange, onchange: (e) => setSettings({ checkRange: e.target.checked }) }), "Exigir que o alvo esteja no alcance do Move"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.mapFx, onchange: (e) => setSettings({ mapFx: e.target.checked }) }), "Animação no mapa (quem acertou quem)"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.dicePlus, onchange: (e) => setSettings({ dicePlus: e.target.checked }) }),
            "Rolar com o Dice+ (dados 3D na tela)",
            h("span", { class: state.dicePlus ? "ok" : "muted" }, state.dicePlus == null ? " · verificando…" : state.dicePlus ? " · instalado ✓" : " · não encontrado na sala")),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: state.settings.dicePlusPopup, onchange: (e) => setSettings({ dicePlusPopup: e.target.checked }) }), "Mostrar também a janelinha de resultado do Dice+"),
          withSheet.length
            ? h("button", {
                style: "margin-top:6px",
                title: "Rola d20 + iniciativa pra cada Pokémon com ficha e manda pro Pretty Sordid",
                onclick: async (ev) => {
                  ev.target.disabled = true;
                  for (const i of withSheet) await rollInitiative(rules, i);
                  ev.target.disabled = false;
                  OBR.notification.show(`Iniciativa rolada pra ${withSheet.length} Pokémon.`, "SUCCESS");
                },
              }, "🎲 Rolar iniciativa de todos")
            : null)
      : null,
    h("div", { class: "card small muted" },
      h("h2", {}, "Como usar"),
      h("div", {}, "1. No app, exporte o Pokémon (copia o código)."),
      h("div", {}, "2. Clique no token → \"Importar ficha do PMP\" → cole."),
      h("div", {}, "3. Selecione o seu Pokémon: a ficha rápida abre no canto. Clique num Move, clique nos alvos no mapa e em Rolar."),
      h("div", {}, "4. Ficha completa: clique no token → \"Ficha PMP\" (ou ☰ na ficha rápida).")),
  ].filter(Boolean));
}

OBR.onReady(async () => {
  syncTheme();
  state.rules = await loadRules();
  state.role = await OBR.player.getRole();
  state.settings = await getSettings();
  dicePlusReady().then((ok) => { state.dicePlus = ok; render(); });
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
