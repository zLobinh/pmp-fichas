// "Mudanças de Status" popup, like the app's screen: the 8 stages (Livro de Regras pág. 73) and the
// Amplification/Reduction damage points (pág. 57-58). Everything here feeds the combat math.
import { OBR, ID, loadRules, getSheet, getItem, updateSheet, canEdit, h, syncTheme } from "./store.js?v=0.8.3";
import { STAGES, stage, addStage, ampPoints, redPoints, setPoints, pointsText } from "./battle.js?v=0.8.3";
import { STAGES_ID } from "./ui.js?v=0.8.3";

const itemId = new URLSearchParams(location.search).get("id");
const root = document.getElementById("root");
const state = { rules: null, item: null, editable: false };
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
const m = (v) => String(v).replace(".", ",");

// what one stat's stages do right now, in plain words
function effect(key, v, prof) {
  if (!v) return "sem efeito";
  switch (key) {
    case "Attack": return `${sign(v * prof)} de dano em Moves corpo a corpo`;
    case "SpecialAttack": return `${sign(v * prof)} de dano em Moves à distância (inclui TR e área)`;
    case "Defense": return `${sign(-v * prof)} no dano recebido corpo a corpo`;
    case "SpecialDefense": return `${sign(-v * prof)} no dano recebido à distância`;
    case "Speed": return `${sign(v * 1.5).replace(".", ",")} m de deslocamento · ${sign(v * prof)} na iniciativa (próxima rodada)`;
    case "Accuracy": return `${sign(v)} no acerto e na CD dos Moves`;
    case "Evasion": return `${sign(v)} na CA e nos testes de resistência`;
    case "CritMargin": return `crítico com ${20 - 3 * v}+ no d20`;
    default: return "";
  }
}

function render() {
  const sheet = getSheet(state.item);
  if (!sheet) { root.replaceChildren(h("div", { class: "empty" }, "Sem ficha.")); return; }
  const pkmn = sheet.pkmn;
  const prof = state.rules.proficiency(pkmn);
  document.getElementById("title").textContent = `Mudanças de Status · ${state.item.name}`;
  const change = (k, d) => updateSheet(itemId, (s) => addStage(s.pkmn, k, d));
  const points = (key, d) => updateSheet(itemId, (s) => setPoints(s.pkmn, key, (s.pkmn[key] ?? 0) + d));
  const amp = ampPoints(pkmn), red = redPoints(pkmn);
  const row = (label, value, cls, onMinus, onPlus, text) =>
    h("div", { class: "stage-row" },
      h("span", { class: "stage-name" }, label),
      state.editable ? h("button", { class: "icon", onclick: onMinus }, "−") : null,
      h("b", { class: `stage-val ${cls}` }, value),
      state.editable ? h("button", { class: "icon", onclick: onPlus }, "+") : null,
      h("span", { class: "stage-fx muted small" }, text));
  root.replaceChildren(
    h("div", { class: "card" },
      h("h2", {}, "Estágios (−6 a +6)"),
      Object.entries(STAGES).map(([k, label]) => {
        const v = stage(pkmn, k);
        return row(label, sign(v), v > 0 ? "ok" : v < 0 ? "no" : "", () => change(k, -1), () => change(k, 1), effect(k, v, prof));
      }),
      h("div", { class: "muted small", style: "margin-top:6px" },
        `Bônus de proficiência ${prof}. Crítico ignora estágios negativos de quem ataca e positivos de quem defende. Margem de Crítico não fica negativa.`)),
    h("div", { class: "card" },
      h("h2", {}, "Pontos de dano (passos de 0,5)"),
      row("Amplificação", m(amp), amp ? "ok" : "", () => points("damage_amp", -0.5), () => points("damage_amp", 0.5), pointsText(amp, 0) || "sem efeito"),
      row("Redução", m(red), red ? "no" : "", () => points("damage_red", -0.5), () => points("damage_red", 0.5), pointsText(0, red) || "sem efeito"),
      h("div", { class: "muted small", style: "margin-top:6px" },
        "Valem pro dano dos Moves deste Pokémon. 0,5 = ½ prof.; 1 = rola 2x; 2 = +1 dado a cada 2; 2 de Redução = dano pela metade. Helping Hand soma 2 (ou 1 com um dado só).")),
    state.editable
      ? h("div", { class: "row" }, h("span", { class: "spacer" }),
          h("button", { onclick: () => updateSheet(itemId, (s) => { s.pkmn.stages = {}; delete s.pkmn.damage_amp; delete s.pkmn.damage_red; }) }, "Zerar tudo"))
      : h("div", { class: "muted small" }, "Só leitura."));
}

OBR.onReady(async () => {
  syncTheme();
  document.getElementById("close").onclick = () => OBR.popover.close(STAGES_ID);
  state.rules = await loadRules();
  state.item = await getItem(itemId);
  state.editable = await canEdit(getSheet(state.item));
  render();
  OBR.scene.items.onChange((items) => {
    const it = items.find((i) => i.id === itemId);
    if (!it) return OBR.popover.close(STAGES_ID);
    state.item = it;
    render();
  });
});
