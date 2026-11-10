// The "Preparar batalha" popup. The GM sets the sides, the format, the reserves, the arena and (for a
// battle between the GM's own trainers) the simulation; each controller picks the starters of the
// trainers it plays and says "pronto". The others' picks are never shown, only "escolhendo" / "pronto".
import { OBR, ID, loadRules, getSheet, h, syncTheme } from "./store.js?v=0.9.13";
import { TEAMS } from "./battle.js?v=0.9.13";
import { trainerOf, party, inBall } from "./trainer.js?v=0.9.13";
import { PREP_KEY, getPrep, setPrep, activesFor, npcTrainer, clearArena } from "./prep.js?v=0.9.13";

const POP = `${ID}/prep`;
const root = document.getElementById("root");
const state = { rules: null, prep: null, trainers: [], parties: {}, isGM: false, players: [], me: null, busy: false, msg: "", npc: {} };

async function load() {
  state.prep = await getPrep();
  if (!state.prep) return render();
  const ids = Object.keys(state.prep.trainers);
  state.trainers = await OBR.scene.items.getItems(ids);
  for (const t of state.trainers) {
    state.parties[t.id] = await party(t.id);
    state.npc[t.id] = await npcTrainer(t, state.isGM ? state.me : null, state.players);
  }
  render();
}
// who plays this trainer from this browser: its owner, or the GM for the NPCs
const mine = (t) => trainerOf(t)?.owner === state.me || (state.isGM && state.npc[t.id]);
const edit = (fn) => setPrep((p) => { fn(p); return p; });

function gmBlock(p) {
  if (!state.isGM) return null;
  const allNpc = state.trainers.every((t) => state.npc[t.id]);
  const lock = p.status !== "setup";
  return h("div", { class: "card" },
    h("h2", {}, "Regras da batalha (mestre)"),
    h("div", { class: "row small", style: "gap:6px;flex-wrap:wrap" },
      h("span", {}, "Formato:"),
      [1, 2, 3].map((n) => h("button", { class: `small ${p.format === n ? "primary" : ""}`, disabled: lock, onclick: () => edit((x) => { x.format = n; for (const t of Object.values(x.trainers)) { t.ready = false; t.starters = []; } }) }, `${n}v${n}`)),
      h("span", { style: "margin-left:8px" }, "Reservas por treinador:"),
      h("input", { type: "number", min: 0, max: 5, value: p.reserves, disabled: lock, style: "width:48px", onchange: (e) => edit((x) => { x.reserves = Math.max(0, Math.min(5, parseInt(e.target.value, 10) || 0)); }) })),
    h("div", { class: "small", style: "margin-top:6px" }, "Lados:"),
    state.trainers.map((t) => h("div", { class: "row small", style: "gap:6px;margin:2px 0" },
      h("img", { src: t.image?.url ?? "", style: "width:22px;height:22px;object-fit:contain" }),
      h("b", {}, t.name), h("span", { class: "muted" }, state.npc[t.id] ? "(mestre)" : "(jogador)"),
      h("span", { class: "spacer" }),
      h("select", { disabled: lock, onchange: (e) => edit((x) => { x.trainers[t.id].side = e.target.value; }) },
        Object.entries(TEAMS).map(([k, v]) => h("option", { value: k, selected: p.trainers[t.id].side === k }, v))),
      h("span", { class: "muted" }, `${activesFor(p, t.id)} em campo`))),
    h("div", { class: "row small", style: "gap:6px;margin-top:6px;flex-wrap:wrap" },
      h("span", {}, "Arena:"),
      h("span", { class: p.arena ? "ok" : "muted" }, p.arena ? "marcada no mapa" : "sem limite"),
      h("button", { class: "small", disabled: lock, title: "Clique em dois cantos do mapa", onclick: async () => {
        await OBR.broadcast.sendMessage(`${ID}/arena-start`, {}, { destination: "LOCAL" });
        state.msg = "Clique em dois cantos opostos da arena no mapa (Esc cancela).";
        render();
      } }, "Marcar arena"),
      p.arena ? h("button", { class: "small", disabled: lock, onclick: async () => { await clearArena(); await edit((x) => { x.arena = null; }); } }, "Tirar") : null),
    allNpc ? h("label", { class: "row small", style: "margin-top:6px;flex-wrap:nowrap;align-items:flex-start;gap:6px" },
      h("input", { type: "checkbox", checked: !!p.sim, disabled: lock, onchange: (e) => edit((x) => { x.sim = e.target.checked; }) }),
      "Simular a batalha (a extensão joga os turnos dos treinadores e mostra um resumo no fim)") : null,
    p.status === "setup" ? h("div", { class: "row", style: "margin-top:8px;gap:6px" },
      h("button", { class: `small ${p.configured ? "" : "primary"}`, onclick: () => edit((x) => { x.configured = !x.configured; }) },
        p.configured ? "Reabrir as regras" : "Regras prontas: liberar a escolha dos iniciais"),
      h("span", { class: "spacer" }),
      h("button", { class: "small", onclick: async () => { await clearArena(); await OBR.scene.setMetadata({ [PREP_KEY]: undefined }); OBR.popover.close(POP); } }, "Cancelar batalha")) : null);
}

// the starters of one of my trainers
function pickBlock(p, t) {
  const entry = p.trainers[t.id];
  const need = activesFor(p, t.id);
  const healthy = (state.parties[t.id] ?? []).filter((x) => getSheet(x).pkmn.hp.current > 0);
  const toggle = (id) => edit((x) => {
    const e = x.trainers[t.id];
    e.ready = false;
    if (e.starters.includes(id)) e.starters = e.starters.filter((s) => s !== id);
    else if (e.starters.length < need) e.starters.push(id);
    else e.starters = [...e.starters.slice(1), id];
  });
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("b", {}, t.name), h("span", { class: "muted small" }, `escolha ${need} inicial(is) · depois ${p.reserves} reserva(s)`),
      h("span", { class: "spacer" }), entry.ready ? h("span", { class: "chip up" }, "pronto") : null),
    h("div", { class: "prep-party" }, healthy.length ? healthy.map((x) => h("button", {
      class: `prep-mon ${entry.starters.includes(x.id) ? "sel" : ""}`, disabled: !p.configured || p.status !== "setup",
      title: `${x.name} · ${getSheet(x).pkmn.hp.current}/${state.rules.maxHP(getSheet(x).pkmn)} HP`, onclick: () => toggle(x.id),
    }, h("img", { src: getSheet(x).realLook?.image?.url ?? x.image?.url ?? "" }), h("span", {}, getSheet(x).realLook?.name ?? x.name),
      entry.starters.includes(x.id) ? h("b", {}, `${entry.starters.indexOf(x.id) + 1}`) : null)) : h("span", { class: "muted small" }, "Nenhum Pokémon de pé.")),
    h("div", { class: "row", style: "margin-top:6px" },
      h("span", { class: "spacer" }),
      h("button", { class: `small ${entry.ready ? "" : "primary"}`, disabled: !p.configured || p.status !== "setup" || entry.starters.length !== Math.min(need, healthy.length),
        onclick: () => edit((x) => { x.trainers[t.id].ready = !x.trainers[t.id].ready; }) }, entry.ready ? "Mudar" : "Pronto")));
}

function render() {
  const p = state.prep;
  if (!p) { root.replaceChildren(h("div", { class: "prep" }, h("div", { class: "card" }, "Nenhuma batalha sendo preparada."), h("button", { onclick: () => OBR.popover.close(POP) }, "Fechar"))); return fit(); }
  const others = state.trainers.filter((t) => !mine(t));
  root.replaceChildren(h("div", { class: "prep" },
    h("div", { class: "row" }, h("b", { class: "hud-name" }, "⚔ Preparar batalha"),
      h("span", { class: "muted small" }, `${p.format}v${p.format} · ${p.reserves} reserva(s)`),
      h("span", { class: "spacer" }), h("button", { class: "icon", onclick: () => OBR.popover.close(POP) }, "✕")),
    state.msg ? h("div", { class: "small ok" }, state.msg) : null,
    p.status === "done" && p.result ? h("div", { class: "card prep-result" }, h("h2", {}, "Resultado"), p.result.lines.map((l) => h("div", { class: "small" }, l)),
      state.isGM ? h("button", { class: "small", style: "margin-top:6px", onclick: async () => { await clearArena(); await OBR.scene.setMetadata({ [PREP_KEY]: undefined }); OBR.popover.close(POP); } }, "Encerrar") : null) : null,
    p.status === "running" ? h("div", { class: "card small" }, p.sim ? "🤖 Batalha sendo simulada… acompanhe pelo mapa e pelo registro." : "⚔ Batalha em andamento.",
      state.isGM && p.sim ? h("button", { class: "small", style: "margin-left:6px", onclick: () => edit((x) => { x.stop = true; x.sim = false; }) }, "Parar a simulação") : null) : null,
    gmBlock(p),
    p.status === "setup" && !p.configured ? h("div", { class: "card small muted" }, "Esperando o mestre definir as regras.") : null,
    p.status === "setup" ? state.trainers.filter(mine).map((t) => pickBlock(p, t)) : null,
    others.length ? h("div", { class: "card" }, h("h2", {}, "Outros lados"),
      others.map((t) => h("div", { class: "row small", style: "gap:6px" }, h("b", {}, t.name), h("span", { class: "muted" }, TEAMS[p.trainers[t.id].side] ?? ""),
        h("span", { class: "spacer" }), h("span", { class: `chip ${p.trainers[t.id].ready ? "up" : ""}` }, p.trainers[t.id].ready ? "pronto" : "escolhendo")))) : null));
  fit();
}
function fit() { requestAnimationFrame(() => OBR.popover.setHeight(POP, Math.min(680, Math.ceil(root.getBoundingClientRect().height) + 8)).catch(() => {})); }

OBR.onReady(async () => {
  syncTheme();
  state.rules = await loadRules();
  state.isGM = (await OBR.player.getRole()) === "GM";
  state.me = OBR.player.id;
  state.players = await OBR.party.getPlayers().catch(() => []);
  await load();
  OBR.scene.onMetadataChange((m) => { if (JSON.stringify(m[PREP_KEY] ?? null) !== JSON.stringify(state.prep)) { state.msg = ""; load(); } });
  OBR.scene.items.onChange(() => { if (state.prep?.status === "setup") load(); });
});
