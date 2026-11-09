// The trainer's team: up to 6 Pokémon with HP, conditions and where they are (on the field, in the
// pokéball, fainted). Release, recall, switch (on its turn, with the action; free after U-turn &
// co.; forced after Roar/Whirlwind), absorb the selected tokens, unlink.
// Only the trainer's owner and the GM see it.
import { OBR, ID, SHEET_KEY, loadRules, getSheet, getItem, updateSheet, h, syncTheme, pushLog } from "./store.js?v=0.9.6";
import { CONDITIONS, conditionsOf, TEAMS } from "./battle.js?v=0.9.6";
import { TRAINER, MAX_PARTY, trainerOf, party, canManage, link, unlink, store, release, switchPokemon, trappedBy, inBall, unmakeTrainer, entryAbilities } from "./trainer.js?v=0.9.6";
import { distanceMeters } from "./map.js?v=0.9.6";
import { longRest } from "./qol.js?v=0.9.6";

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

const hpPct = (s) => Math.max(0, Math.min(100, (s.pkmn.hp.current / Math.max(1, state.rules.maxHP(s.pkmn))) * 100));
const hpClass = (pct) => (pct <= 25 ? "crit" : pct <= 50 ? "low" : "");

// one of the 6 framed slots of the card (empty ones show just the pokéball)
function slotCard(p, i) {
  if (!p) return h("div", { class: "tc-slot empty", title: "Vazio" }, h("div", { class: "tc-ball" }));
  const s = getSheet(p);
  const out = !inBall(s);
  const fainted = s.pkmn.hp.current <= 0;
  const from = state.list.find((x) => x.id === state.switchFrom);
  const canEnter = from && !out && !fainted && from.id !== p.id;
  const pct = hpPct(s);
  return h("div", {
    class: `tc-slot ${fainted ? "fainted" : ""} ${out && !fainted ? "out" : ""} ${state.sel === p.id ? "sel" : ""} ${from?.id === p.id ? "leaving" : ""} ${canEnter ? "can-enter" : ""}`,
    title: `${p.name} · ${s.pkmn.hp.current}/${state.rules.maxHP(s.pkmn)} HP`,
    onclick: () => { state.sel = p.id; render(); },
  },
    h("div", { class: "tc-ball" }, h("img", { src: p.image?.url ?? "", alt: "" })),
    h("span", { class: "tc-lv" }, `Nv ${state.rules.level(s.pkmn)}`),
    fainted ? h("span", { class: "tc-where down" }, "desmaiado") : out ? h("span", { class: "tc-where" }, "em campo") : null,
    Object.keys(conditionsOf(s)).length ? h("span", { class: "tc-cond" }, Object.keys(conditionsOf(s)).map((k) => CONDITIONS[k]?.icon ?? "•").join("")) : null,
    h("div", { class: "tc-name" }, p.name),
    h("div", { class: "tc-hp" }, h("i", { class: hpClass(pct), style: `width:${pct}%` })));
}

// what can be done with the selected Pokémon
function details(p) {
  if (!p) return null;
  const s = getSheet(p);
  const out = !inBall(s);
  const fainted = s.pkmn.hp.current <= 0;
  const from = state.list.find((x) => x.id === state.switchFrom);
  const cond = conditionsOf(s);
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
  return h("div", { class: "tc-detail" },
    h("div", { class: "row" },
      h("b", {}, p.name), h("span", { class: "tc-muted small" }, `Nv ${state.rules.level(s.pkmn)}`),
      h("span", { class: "spacer" }),
      h("span", { class: "small" }, `${s.pkmn.hp.current}/${state.rules.maxHP(s.pkmn)} HP`)),
    h("div", { class: "row small", style: "gap:4px;flex-wrap:wrap" },
      Object.keys(cond).map((k) => h("span", { class: "chip cond" }, `${CONDITIONS[k]?.icon ?? ""} ${CONDITIONS[k]?.label ?? k}`)),
      s.battle?.trapped ? h("span", { class: "chip down" }, `preso (${s.battle.trapped.move})`) : null,
      s.battle?.mustSwitch ? h("span", { class: "chip down" }, `tem que trocar (${s.battle.mustSwitch.by})`) : null,
      !Object.keys(cond).length && !s.battle?.trapped && !s.battle?.mustSwitch ? h("span", { class: "tc-muted" }, fainted ? "Desmaiado" : out ? "Em campo" : "Na pokébola") : null),
    buttons.length ? h("div", { class: "row", style: "gap:4px;margin-top:6px;flex-wrap:wrap" }, buttons) : null);
}

// 8 badges along the bottom; the GM clicks to give or take one
const BADGE_COLORS = ["#9aa3ad", "#4aa3df", "#f2c94c", "#6fcf97", "#bb6bd9", "#eb5757", "#f2994a", "#56ccf2"];
function badges() {
  const got = trainerOf(state.trainer).badges ?? [];
  const toggle = (i) => act(async () => {
    await OBR.scene.items.updateItems([trainerId], (ds) => {
      for (const d0 of ds) {
        const b = [...(d0.metadata[TRAINER].badges ?? [])];
        b[i] = !b[i];
        d0.metadata[TRAINER] = { ...d0.metadata[TRAINER], badges: b };
      }
    });
  });
  return h("div", { class: "tc-badges" },
    h("span", { class: "tc-badges-title" }, "INSÍGNIAS"),
    h("div", { class: "tc-badge-row" }, BADGE_COLORS.map((c, i) => h("span", {
      class: `tc-badge ${got[i] ? "on" : ""}`, style: `--badge:${c}`,
      title: `Insígnia ${i + 1}${got[i] ? "" : " (ainda não)"}${state.isGM ? " · clique pra marcar" : ""}`,
      onclick: state.isGM ? () => toggle(i) : null,
    }, h("i", {})))));
}

async function doRest() {
  await act(async () => {
    const names = await longRest(state.rules, trainerId);
    if (names.length) await pushLog({ kind: "note", attacker: state.trainer.name, text: `descanso longo: ${names.join(", ")} com HP e PP cheios, sem condições` });
    state.msg = names.length ? "Equipe descansada." : "";
  });
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
  return h("div", { class: "row small tc-owner" },
    h("span", {}, "Dono"),
    // handing the trainer to a player puts it (and its team) on the players' side
    h("select", { onchange: (e) => setT(e.target.value === OBR.player.id ? { owner: e.target.value } : { owner: e.target.value, team: "jogadores" }) },
      [{ id: OBR.player.id, name: "Mestre" }, ...state.players].map((p) => h("option", { value: p.id, selected: t.owner === p.id }, p.name))),
    h("span", {}, "Equipe"),
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
  // in switch mode the first one that can come in is picked
  if (from && (!state.sel || state.sel === from.id)) state.sel = state.list.find((p) => p.id !== from.id && inBall(getSheet(p)) && getSheet(p).pkmn.hp.current > 0)?.id ?? from.id;
  if (!state.list.some((p) => p.id === state.sel)) state.sel = state.list[0]?.id ?? null;
  const slots = Array.from({ length: MAX_PARTY }, (_, i) => state.list.find((p) => getSheet(p).slot === i) ?? null);
  // (a Pokémon with a slot number out of 0-5 still shows up, in the first free place)
  for (const p of state.list) if (!slots.includes(p)) { const k = slots.indexOf(null); if (k >= 0) slots[k] = p; }
  const team = trainerOf(state.trainer).team;
  root.replaceChildren(h("div", { class: "tcard" },
    h("div", { class: "tc-head" },
      h("div", { class: "tc-title" }, "Trainer Card"),
      h("div", { class: "tc-trainer-name", title: TEAMS[team] ?? "" }, state.trainer.name || "Treinador"),
      h("button", { class: "icon tc-close", title: "Fechar", onclick: () => OBR.popover.close(POP) }, "✕")),
    h("div", { class: "tc-sub" },
      h("span", {}, `${state.list.length}/${MAX_PARTY} Pokémon`),
      h("span", { class: `tc-team ${team}` }, TEAMS[team] ?? team)),
    ownerBlock(),
    from ? h("div", { class: "tc-switch" },
      h("b", {}, `Trocar ${from.name}: escolha quem entra`),
      h("div", { class: "small" }, must?.forced ? `Forçado por ${must.by}.`
        : must?.free ? `${must.by}: ação livre${must.batonPass ? ", passa os estágios" : ""}.`
        : "Gasta a ação deste turno; quem entra só tem ação bônus e reação e rola iniciativa na próxima rodada."),
      must ? null : h("button", { class: "small", onclick: () => { state.switchFrom = null; render(); } }, "Cancelar")) : null,
    state.msg ? h("div", { class: "tc-msg small" }, state.msg) : null,
    h("div", { class: "tc-body" },
      h("div", { class: "tc-grid" }, slots.map(slotCard)),
      h("div", { class: "tc-art" }, state.trainer.image?.url ? h("img", { src: state.trainer.image.url, alt: "" }) : null)),
    details(state.list.find((p) => p.id === state.sel)),
    badges(),
    h("div", { class: "tc-actions" },
      state.list.length < MAX_PARTY ? h("button", { class: "small", disabled: state.busy, title: "Selecione no mapa os tokens dos Pokémon (com ficha) e clique aqui", onclick: absorbSelected }, "Guardar os selecionados") : null,
      state.list.length ? h("button", { class: "small primary", disabled: state.busy, title: "Fora do combate: HP e PP cheios, condições e estágios limpos (a equipe toda)", onclick: doRest }, "Descanso longo") : null,
      h("span", { class: "spacer" }),
      h("button", { class: "small", disabled: state.busy, title: "O token deixa de ser treinador (precisa liberar os guardados antes)", onclick: () => act(async () => { await unmakeTrainer(state.trainer); OBR.popover.close(POP); }) }, "Deixar de ser treinador"))));
  requestAnimationFrame(() => OBR.popover.setHeight(POP, Math.min(700, Math.ceil(root.getBoundingClientRect().height) + 4)).catch(() => {}));
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
