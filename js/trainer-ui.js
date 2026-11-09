// The trainer's team: up to 6 Pokémon with HP, conditions and where they are (on the field, in the
// pokéball, fainted). Release, recall, switch (on its turn, with the action; free after U-turn &
// co.; forced after Roar/Whirlwind), absorb the selected tokens, unlink.
// Only the trainer's owner and the GM see it.
import { OBR, ID, SHEET_KEY, loadRules, getSheet, getItem, updateSheet, h, syncTheme, pushLog } from "./store.js?v=0.9.3";
import { CONDITIONS, conditionsOf, TEAMS } from "./battle.js?v=0.9.3";
import { TRAINER, MAX_PARTY, trainerOf, party, canManage, link, unlink, store, release, switchPokemon, trappedBy, inBall, unmakeTrainer, entryAbilities } from "./trainer.js?v=0.9.3";
import { distanceMeters } from "./map.js?v=0.9.3";

const params = new URLSearchParams(location.search);
const trainerId = params.get("id");
const POP = `${ID}/trainer`;
const root = document.getElementById("root");
const state = { rules: null, trainer: null, list: [], switchFrom: params.get("switch"), busy: false, msg: "", isGM: false, players: [] };

const running = async () => (await OBR.scene.items.getItems((i) => i.metadata?.["com.pretty-initiative/metadata"]?.active === true)).length > 0;

async function act(fn) {
  state.busy = true;
  state.msg = "";
  render();
  try { await fn(); }
  catch (e) { state.msg = e.message; }
  finally { state.busy = false; await refresh(); }
}

async function refresh() {
  state.trainer = await getItem(trainerId);
  state.list = state.trainer ? await party(trainerId) : [];
  // a Pokémon that must switch (Roar, U-turn...) opens the panel in switch mode
  const must = state.list.find((p) => !inBall(getSheet(p)) && getSheet(p).battle?.mustSwitch);
  if (must && !state.switchFrom) state.switchFrom = must.id;
  render();
}

function hpBar(s) {
  const max = Math.max(1, state.rules.maxHP(s.pkmn));
  const pct = Math.max(0, Math.min(100, (s.pkmn.hp.current / max) * 100));
  return h("div", { class: "hpbar" }, h("i", { class: pct <= 25 ? "crit" : pct <= 50 ? "low" : "", style: `width:${pct}%` }));
}

function slotRow(p) {
  const s = getSheet(p);
  const out = !inBall(s);
  const fainted = s.pkmn.hp.current <= 0;
  const from = state.list.find((x) => x.id === state.switchFrom);
  const cond = conditionsOf(s);
  const where = fainted ? "desmaiado" : out ? "em campo" : "na pokébola";
  const buttons = [];
  if (from && !out && !fainted && from.id !== p.id) {
    buttons.push(h("button", { class: "small primary", disabled: state.busy, onclick: () => doSwitch(from, p) }, `Entrar no lugar de ${from.name}`));
  } else if (!from) {
    if (!out) buttons.push(h("button", { class: "small primary", disabled: state.busy || fainted, onclick: () => doRelease(p) }, "Liberar"));
    if (out) {
      buttons.push(h("button", { class: "small", disabled: state.busy, onclick: () => { state.switchFrom = p.id; render(); } }, "Trocar"));
      buttons.push(h("button", { class: "small", disabled: state.busy, onclick: () => doRecall(p) }, "Recolher"));
      buttons.push(h("button", { class: "small", disabled: state.busy, title: "Tira da equipe (o token fica no mapa)", onclick: () => act(() => unlink(p)) }, "Desvincular"));
    }
  }
  return h("div", { class: `tslot ${fainted ? "fainted" : ""} ${from?.id === p.id ? "leaving" : ""}` },
    h("img", { src: p.image?.url ?? "", alt: "" }),
    h("div", { class: "tslot-body" },
      h("div", { class: "row" },
        h("b", {}, p.name), h("span", { class: "muted small" }, `Nv ${state.rules.level(s.pkmn)}`),
        h("span", { class: "spacer" }),
        h("span", { class: `small ${out && !fainted ? "ok" : "muted"}` }, where)),
      hpBar(s),
      h("div", { class: "row small", style: "gap:4px;flex-wrap:wrap" },
        h("span", { class: "muted" }, `${s.pkmn.hp.current}/${state.rules.maxHP(s.pkmn)} HP`),
        Object.keys(cond).map((k) => h("span", { class: "chip cond" }, `${CONDITIONS[k]?.icon ?? ""} ${CONDITIONS[k]?.label ?? k}`)),
        s.battle?.trapped ? h("span", { class: "chip down" }, `preso (${s.battle.trapped.move})`) : null,
        s.battle?.mustSwitch ? h("span", { class: "chip down" }, `tem que trocar (${s.battle.mustSwitch.by})`) : null),
      buttons.length ? h("div", { class: "row", style: "gap:4px;margin-top:4px;flex-wrap:wrap" }, buttons) : null));
}

async function doRelease(p) {
  await act(async () => {
    const combat = await running();
    await release(state.rules, p, state.trainer);
    if (combat) {
      // entering mid-combat: no action this turn, joins the initiative at the next round
      await updateSheet(p.id, (s) => { s.battle.econ = { action: false, bonus: true, reaction: true }; s.battle.needsInitiative = true; s.battle.joinNextRound = true; });
      await pushLog({ kind: "note", attacker: state.trainer.name, text: `${p.name} entrou no combate (rola iniciativa no começo da próxima rodada)` });
    }
    await entryAbilities(state.rules, await getItem(p.id));
  });
}

async function doRecall(p) {
  await act(async () => {
    if (await running()) {
      const d = await distanceMeters(state.trainer, p);
      if (d > 18.05 && getSheet(p).pkmn.hp.current > 0) throw new Error(`O treinador precisa estar a até 18 m (está a ${Math.round(d * 10) / 10} m).`);
    }
    await store(state.rules, p, state.trainer);
  });
}

async function doSwitch(from, to) {
  await act(async () => {
    const must = getSheet(from).battle?.mustSwitch;
    await switchPokemon(state.rules, from, to, {
      forced: !!must?.forced, free: !!must?.free, batonPass: !!must?.batonPass, by: must?.by,
    });
    state.switchFrom = null;
  });
}

async function absorbSelected() {
  await act(async () => {
    const sel = (await OBR.player.getSelection()) ?? [];
    const items = (await OBR.scene.items.getItems(sel.filter((id) => id !== trainerId))).filter((i) => getSheet(i));
    if (!items.length) throw new Error("Selecione no mapa os tokens dos Pokémon (com ficha) e clique de novo.");
    await link(state.rules, state.trainer, items);
  });
}

function ownerBlock() {
  if (!state.isGM) return null;
  const t = trainerOf(state.trainer);
  const setT = (patch) => act(async () => {
    await OBR.scene.items.updateItems([trainerId], (ds) => { for (const d0 of ds) d0.metadata[TRAINER] = { ...d0.metadata[TRAINER], ...patch }; });
    for (const p of state.list) await updateSheet(p.id, (s) => { if (patch.owner) s.owner = patch.owner; if (patch.team) s.team = patch.team; });
  });
  return h("div", { class: "row small", style: "gap:6px;margin:4px 0" },
    h("span", { class: "muted" }, "Dono"),
    h("select", { onchange: (e) => setT({ owner: e.target.value }) },
      [{ id: OBR.player.id, name: "Mestre" }, ...state.players].map((p) => h("option", { value: p.id, selected: t.owner === p.id }, p.name))),
    h("span", { class: "muted" }, "Equipe"),
    h("select", { onchange: (e) => setT({ team: e.target.value }) },
      Object.entries(TEAMS).map(([k, v]) => h("option", { value: k, selected: t.team === k }, v))));
}

function render() {
  if (!state.trainer || !trainerOf(state.trainer)) {
    root.replaceChildren(h("div", { class: "card" }, "Esse token não é mais um treinador."));
    return;
  }
  const from = state.list.find((x) => x.id === state.switchFrom);
  const must = from && getSheet(from).battle?.mustSwitch;
  root.replaceChildren(h("div", { class: "trainer" },
    h("div", { class: "row" },
      h("b", { class: "hud-name" }, state.trainer.name || "Treinador"),
      h("span", { class: "muted small" }, `${state.list.length}/${MAX_PARTY} Pokémon`),
      h("span", { class: "spacer" }),
      h("button", { class: "icon", title: "Fechar", onclick: () => OBR.popover.close(POP) }, "✕")),
    ownerBlock(),
    from ? h("div", { class: "hud-target" },
      h("b", {}, `Trocar ${from.name}`),
      h("div", { class: "small muted" }, must?.forced ? `Forçado por ${must.by}: escolha quem entra.`
        : must?.free ? `${must.by}: escolha quem entra (ação livre${must.batonPass ? ", passa os estágios" : ""}).`
        : "Gasta a ação deste turno; quem entra só tem ação bônus e reação e rola iniciativa na próxima rodada."),
      must ? null : h("button", { class: "small", onclick: () => { state.switchFrom = null; render(); } }, "Cancelar")) : null,
    state.msg ? h("div", { class: "no small", style: "margin:4px 0" }, state.msg) : null,
    state.list.length ? state.list.map(slotRow) : h("div", { class: "muted small" }, "Nenhum Pokémon ainda."),
    state.list.length < MAX_PARTY ? h("div", { class: "card small", style: "margin-top:6px" },
      "Pra guardar Pokémon: selecione os tokens deles no mapa (com ficha) e clique ",
      h("button", { class: "small primary", disabled: state.busy, onclick: absorbSelected }, "Guardar os selecionados"),
      h("div", { class: "muted" }, "Ou selecione o treinador e os Pokémon juntos e use \"Guardar no treinador\" no menu do botão direito.")) : null,
    h("div", { class: "row", style: "margin-top:8px" },
      h("span", { class: "spacer" }),
      h("button", { class: "small", disabled: state.busy, title: "O token deixa de ser treinador (precisa liberar os guardados antes)", onclick: () => act(async () => { await unmakeTrainer(state.trainer); OBR.popover.close(POP); }) }, "Deixar de ser treinador"))));
  requestAnimationFrame(() => OBR.popover.setHeight(POP, Math.min(640, Math.ceil(root.getBoundingClientRect().height) + 4)).catch(() => {}));
}

OBR.onReady(async () => {
  syncTheme();
  state.rules = await loadRules();
  state.isGM = (await OBR.player.getRole()) === "GM";
  state.players = (await OBR.party.getPlayers().catch(() => [])).map((p) => ({ id: p.id, name: p.name }));
  state.trainer = await getItem(trainerId);
  if (!state.trainer || !(await canManage(state.trainer))) {
    root.replaceChildren(h("div", { class: "card" }, "Só o dono deste treinador (e o mestre) vê a equipe."));
    return;
  }
  await refresh();
  OBR.scene.items.onChange((items) => {
    if (state.busy) return;
    const changed = items.some((i) => i.id === trainerId || i.metadata?.[SHEET_KEY]?.trainer === trainerId);
    if (changed) refresh();
  });
});
