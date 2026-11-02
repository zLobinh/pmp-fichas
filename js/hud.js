// Quick sheet: opens when a controllable Pokémon is selected. HP + moves; pick a move,
// click the targets on the map, then roll.
import { OBR, ID, HUD_ID, loadRules, getSheet, getItem, updatePokemon, canEdit, h, syncTheme } from "./store.js?v=0.2.0";
import { TYPE_PT, ATTR_PT, signed } from "./rules.js?v=0.2.0";
import { useMove } from "./combat.js?v=0.2.0";
import { TYPE_COLOR, openSheet } from "./ui.js?v=0.2.0";

const root = document.getElementById("root");
const state = {
  rules: null,
  attackerId: new URLSearchParams(location.search).get("id"),
  item: null,
  mode: "idle", // "idle" | "target"
  pending: null, // move name waiting for targets
  targets: [],
  last: null,
  busy: false,
};

async function setAttacker(id) {
  state.attackerId = id;
  state.item = await getItem(id);
  state.mode = "idle";
  state.pending = null;
  state.targets = [];
  state.last = null;
}

async function onSelection(selection) {
  const ids = selection ?? [];
  if (state.mode === "target") {
    const others = ids.filter((id) => id !== state.attackerId);
    state.targets = others.length ? await OBR.scene.items.getItems(others) : [];
    return render();
  }
  // follow the selection to another Pokémon this player controls
  if (ids.length === 1 && ids[0] !== state.attackerId) {
    const [it] = await OBR.scene.items.getItems(ids);
    if (getSheet(it) && (await canEdit(getSheet(it)))) {
      await setAttacker(it.id);
      render();
    }
  }
}

function hpBlock(pkmn) {
  const { rules } = state;
  const max = rules.maxHP(pkmn);
  const cur = pkmn.hp.current;
  const temp = pkmn.hp.temp ?? 0;
  const pct = Math.max(0, Math.min(100, (cur / max) * 100));
  const amount = h("input", { type: "number", min: "0", placeholder: "0", class: "hud-num" });
  const apply = (fn) => async () => {
    const n = Math.abs(parseInt(amount.value, 10) || 0);
    if (!n) return amount.focus();
    await updatePokemon(state.attackerId, (p) => fn(p, n));
  };
  const active = Object.keys(pkmn.statuses ?? {});
  return h("div", { class: "hud-hp" },
    h("div", { class: "row" },
      h("b", { class: "hud-hpnum" }, `${cur}`), h("span", { class: "muted small" }, `/ ${max} HP`),
      temp ? h("span", { class: "small", style: "color:var(--temp)" }, `+${temp}`) : null,
      cur <= 0 ? h("span", { class: "no small", style: "font-weight:700" }, "DESMAIADO") : null,
      h("span", { class: "spacer" }),
      h("span", { class: "muted small" }, `CA ${rules.ac(pkmn)}`)),
    h("div", { class: "hpbar" }, h("i", { class: pct <= 25 ? "crit" : pct <= 50 ? "low" : "", style: `width:${pct}%` })),
    h("div", { class: "row" },
      amount,
      h("button", { class: "small", onclick: apply((p, n) => { const t = Math.min(p.hp.temp ?? 0, n); p.hp.temp = (p.hp.temp ?? 0) - t; p.hp.current = Math.max(0, p.hp.current - (n - t)); }) }, "Dano"),
      h("button", { class: "small", onclick: apply((p, n) => { p.hp.current = Math.min(rules.maxHP(p), p.hp.current + n); }) }, "Curar"),
      h("span", { class: "spacer" }),
      active.length ? h("span", { class: "small warn" }, active.map((s) => ({ Burning: "Queimado", Frozen: "Congelado", Paralyzed: "Paralisado", Poisoned: "Envenenado", Asleep: "Dormindo", Confused: "Confuso" })[s] ?? s).join(", ")) : null));
}

function moveRow(m) {
  const noPP = typeof m.pp === "number" && m.pp <= 0;
  const nums = [
    m.attackBonus != null ? `Acerto ${signed(m.attackBonus)}` : null,
    m.saveDC != null ? `CD ${m.saveDC} ${ATTR_PT[m.save] ?? m.save}` : null,
    m.damage ? m.damageText : null,
  ].filter(Boolean).join(" · ");
  const selected = state.pending === m.name;
  return h("button", {
    class: `hud-move ${selected ? "sel" : ""}`,
    style: `--type:${TYPE_COLOR[m.type] ?? "#777"}`,
    disabled: noPP || state.busy,
    title: `${TYPE_PT[m.type] ?? m.type} · ${[m.time, m.range].filter(Boolean).join(" · ")}`,
    onclick: () => {
      state.mode = "target";
      state.pending = m.name;
      state.targets = [];
      render();
    },
  },
    h("span", { class: "hud-move-name" }, m.label.replace(/ PMP$/, "")),
    h("span", { class: "hud-move-nums" }, nums || "sem rolagem"),
    h("span", { class: `hud-move-pp ${noPP ? "no" : ""}` }, typeof m.pp === "number" ? `${m.pp}/${m.ppMax}` : "∞"));
}

function targetBar() {
  if (state.mode !== "target") return null;
  const move = state.rules.moveData(getSheet(state.item).pkmn, state.pending);
  return h("div", { class: "hud-target" },
    h("div", { class: "small" }, h("b", {}, move.label.replace(/ PMP$/, "")), " → clique nos alvos no mapa (Shift+clique pra vários)"),
    h("div", { class: "targets", style: "margin:4px 0" },
      state.targets.length
        ? state.targets.map((t) => {
            const p = getSheet(t)?.pkmn;
            return h("span", { class: "chip on" }, t.name || "Token", p ? ` · CA ${state.rules.ac(p)}` : "");
          })
        : h("span", { class: "muted small" }, "Nenhum alvo: rola só o dano.")),
    h("div", { class: "row" },
      h("button", { class: "primary", disabled: state.busy, onclick: roll }, state.busy ? "Rolando…" : "Rolar"),
      h("button", { onclick: () => { state.mode = "idle"; state.pending = null; state.targets = []; render(); } }, "Cancelar")));
}

function resultLine() {
  const e = state.last;
  if (!e || state.mode === "target") return null;
  return h("div", { class: "hud-result" },
    h("div", { class: "muted small" }, e.move),
    e.results.map((r) => {
      if (!r.target) return h("div", {}, r.note);
      const bits = [h("b", {}, r.target), " "];
      if (r.attack) bits.push(h("span", { class: r.attack.hit ? "ok" : "no" }, r.attack.crit ? "CRÍTICO" : r.attack.hit ? "acertou" : "errou"), ` (${r.attack.total}${r.attack.ac != null ? ` vs ${r.attack.ac}` : ""}) `);
      if (r.save && !r.save.unknown) bits.push(h("span", { class: r.save.success ? "no" : "ok" }, `${r.save.effectOnly ? "efeito: " : ""}TR ${r.save.total} vs ${r.save.dc} ${r.save.success ? "passou" : "falhou"} `));
      if (r.save?.unknown) bits.push(`TR ${r.save.attr} CD ${r.save.dc} `);
      if (r.damage) bits.push(h("b", {}, `${r.damage.final} dano`), r.damage.effLabel ? ` ${r.damage.effLabel}` : "");
      if (r.hpAfter) bits.push(h("span", { class: "muted" }, ` → ${r.hpAfter}`));
      return h("div", {}, bits);
    }));
}

async function roll() {
  state.busy = true;
  render();
  try {
    state.item = await getItem(state.attackerId);
    state.last = await useMove(state.rules, state.item, state.pending, state.targets);
  } catch (e) {
    OBR.notification.show(e.message, "ERROR");
  } finally {
    state.busy = false;
    state.mode = "idle";
    state.pending = null;
    state.targets = [];
    await OBR.player.select([state.attackerId], true); // back to the attacker
    render();
  }
}

async function close() {
  await OBR.broadcast.sendMessage(`${ID}/hud-closed`, {}, { destination: "LOCAL" });
  await OBR.popover.close(HUD_ID);
}

function render() {
  const sheet = getSheet(state.item);
  if (!sheet) {
    root.replaceChildren(h("div", { class: "hud" }, h("div", { class: "row" }, h("span", { class: "muted" }, "Sem ficha."), h("span", { class: "spacer" }), h("button", { class: "icon", onclick: close }, "✕"))));
    return fit();
  }
  const pkmn = sheet.pkmn;
  const { rules } = state;
  root.replaceChildren(h("div", { class: "hud" },
    h("div", { class: "row hud-head" },
      h("b", { class: "hud-name" }, state.item.name || rules.name(pkmn)),
      h("span", { class: "muted small" }, `Nv ${rules.level(pkmn)}`),
      rules.types(pkmn).map((t) => h("span", { class: "dot", style: `background:${TYPE_COLOR[t]}`, title: TYPE_PT[t] })),
      h("span", { class: "spacer" }),
      h("button", { class: "icon", title: "Ficha completa", onclick: () => openSheet(state.attackerId) }, "☰"),
      h("button", { class: "icon", title: "Fechar", onclick: close }, "✕")),
    hpBlock(pkmn),
    targetBar(),
    h("div", { class: "hud-moves" }, rules.moveList(pkmn).map(moveRow)),
    resultLine()));
  fit();
}

// grow/shrink the popover to its content
function fit() {
  requestAnimationFrame(() => {
    const height = Math.min(600, Math.ceil(root.getBoundingClientRect().height) + 2);
    OBR.popover.setHeight(HUD_ID, height).catch(() => {});
  });
}

OBR.onReady(async () => {
  syncTheme();
  state.rules = await loadRules();
  await setAttacker(state.attackerId);
  render();
  OBR.scene.items.onChange((items) => {
    const it = items.find((i) => i.id === state.attackerId);
    if (it) state.item = it;
    state.targets = state.targets.map((t) => items.find((i) => i.id === t.id)).filter(Boolean);
    render();
  });
  OBR.player.onChange((p) => onSelection(p.selection));
});
