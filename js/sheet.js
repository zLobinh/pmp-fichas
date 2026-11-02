// The sheet popover of one token: HP, stats, statuses, targets and moves.
import { OBR, ID, SHEET_KEY, STATUSES, loadRules, getSheet, getItem, updatePokemon, canEdit, pushLog, getSettings, h, syncTheme } from "./store.js?v=0.4.0";
import { getRoller } from "./dice.js?v=0.4.0";
import { AIM_START, AIM_DONE, AIM_CANCEL } from "./area.js?v=0.4.0";
import { ATTRS, ATTR_PT, TYPE_PT, signed, d } from "./rules.js?v=0.4.0";
import { useMove, describe } from "./combat.js?v=0.4.0";
import { TYPE_COLOR, die } from "./ui.js?v=0.4.0";
import { OutOfRange, rollInitiative, initiativeOf } from "./map.js?v=0.4.0";
const typeTag = (t) => h("span", { class: "tag", style: `background:${TYPE_COLOR[t] ?? "#777"}` }, TYPE_PT[t] ?? t);
const modOf = (v) => Math.floor((v - 10) / 2);

const itemId = new URLSearchParams(location.search).get("id");
const root = document.getElementById("root");
const state = { rules: null, item: null, targets: [], editable: false, openDetails: new Set(), last: null, busy: false, forceMove: null, rangeMsg: null };

async function refreshTargets(selection) {
  const ids = (selection ?? (await OBR.player.getSelection()) ?? []).filter((id) => id !== itemId);
  state.targets = ids.length ? await OBR.scene.items.getItems(ids) : [];
}

function hpCard(pkmn) {
  const { rules } = state;
  const max = rules.maxHP(pkmn);
  const cur = pkmn.hp.current;
  const temp = pkmn.hp.temp ?? 0;
  const pct = Math.max(0, Math.min(100, (cur / max) * 100));
  const amount = h("input", { type: "number", min: "0", value: "", placeholder: "0", style: "width:62px" });
  const act = (fn) => async () => {
    const n = Math.abs(parseInt(amount.value, 10) || 0);
    if (!n) return amount.focus();
    await updatePokemon(itemId, (p) => fn(p, n));
  };
  return h("div", { class: "card" },
    h("div", { class: "row" },
      h("span", { class: "big" }, `${cur}`), h("span", { class: "muted" }, ` / ${max} HP`),
      temp ? h("span", { class: "chip", style: "border-color:var(--temp)" }, `+${temp} temp`) : null,
      h("span", { class: "spacer" }),
      cur <= 0 ? h("span", { class: "no", style: "font-weight:700" }, "DESMAIADO") : null),
    h("div", { class: "hpbar" }, h("i", { class: pct <= 25 ? "crit" : pct <= 50 ? "low" : "", style: `width:${pct}%` })),
    state.editable ? h("div", { class: "row" }, amount,
      h("button", { onclick: act((p, n) => { const t = Math.min(p.hp.temp ?? 0, n); p.hp.temp = (p.hp.temp ?? 0) - t; p.hp.current = Math.max(0, p.hp.current - (n - t)); }) }, "Dano"),
      h("button", { onclick: act((p, n) => { p.hp.current = Math.min(rules.maxHP(p), p.hp.current + n); }) }, "Curar"),
      h("button", { onclick: act((p, n) => { p.hp.temp = n; }) }, "HP temp")) : null);
}

function statsCard(pkmn) {
  const { rules } = state;
  const attrs = rules.attributes(pkmn);
  const saves = rules.saves(pkmn);
  const sp = rules.speciesData(pkmn);
  return h("div", { class: "card" },
    h("div", { class: "kv" },
      h("div", {}, h("b", {}, rules.ac(pkmn)), h("span", { class: "muted small" }, "CA")),
      h("div", {}, h("b", {}, signed(rules.proficiency(pkmn))), h("span", { class: "muted small" }, "Prof.")),
      h("div", {}, h("b", {}, signed(rules.stabBonus(pkmn))), h("span", { class: "muted small" }, "STAB")),
      h("div", {}, h("b", {}, signed(rules.initiative(pkmn))), h("span", { class: "muted small" }, "Inic.")),
      sp?.WSp ? h("div", {}, h("b", {}, `${sp.WSp}`), h("span", { class: "muted small" }, "Desl.")) : null,
      h("span", { class: "spacer" }),
      state.editable ? h("button", {
        title: "Rola d20 + iniciativa e coloca no Pretty Sordid",
        disabled: state.busy,
        onclick: async () => {
          try { state.last = await rollInitiative(rules, state.item); state.last._fresh = state.last.roller !== "Dice+"; render(); }
          catch (e) { OBR.notification.show(e.message, "ERROR"); }
        },
      }, initiativeOf(state.item) ? `🎲 Iniciativa (${initiativeOf(state.item).count})` : "🎲 Iniciativa") : null),
    h("div", { class: "stats", style: "margin-top:8px" },
      ATTRS.map((k) => h("div", { class: "stat", title: `Teste de resistência ${signed(saves[k])}`, style: "cursor:pointer", onclick: () => rollCheck(`TR ${ATTR_PT[k]}`, saves[k]) },
        h("span", {}, ATTR_PT[k]), h("b", {}, attrs[k]), h("span", {}, signed(modOf(attrs[k])))))),
    h("div", { class: "muted small", style: "margin-top:6px" }, "Clique num atributo pra rolar o teste de resistência."));
}

function infoCard(pkmn) {
  const { rules } = state;
  const sts = pkmn.statuses ?? {};
  return h("div", { class: "card" },
    h("div", { class: "row" }, rules.types(pkmn).map(typeTag),
      h("span", { class: "muted small" }, `Natureza: ${pkmn.nature ?? "—"}`)),
    h("div", { class: "small", style: "margin-top:6px" }, h("span", { class: "muted" }, "Habilidades: "), rules.abilities(pkmn).join(", ") || "—"),
    pkmn.item ? h("div", { class: "small" }, h("span", { class: "muted" }, "Item: "), pkmn.item) : null,
    h("div", { class: "row", style: "margin-top:6px" },
      Object.entries(STATUSES).map(([k, label]) =>
        h("span", {
          class: `chip status ${sts[k] ? "on" : ""}`,
          title: state.editable ? "Clique pra ligar/desligar" : "",
          onclick: state.editable ? () => updatePokemon(itemId, (p) => { p.statuses ??= {}; if (p.statuses[k]) delete p.statuses[k]; else p.statuses[k] = true; }) : null,
        }, label))));
}

function targetsCard() {
  const { rules } = state;
  return h("div", { class: "card" },
    h("h2", {}, "Alvos"),
    state.targets.length
      ? h("div", { class: "targets" }, state.targets.map((t) => {
          const p = getSheet(t)?.pkmn;
          return h("span", { class: "chip on" }, t.name || "Token", p ? ` · CA ${rules.ac(p)} · HP ${p.hp.current}/${rules.maxHP(p)}` : " · sem ficha");
        }))
      : h("div", { class: "muted small" }, "Selecione os alvos no mapa (Shift+clique pra vários). Sem alvo, o Move só rola o dano."));
}

function moveCard(m) {
  const color = TYPE_COLOR[m.type] ?? "#777";
  const noPP = typeof m.pp === "number" && m.pp <= 0;
  const changePP = (delta) => updatePokemon(itemId, (p) => {
    const cur = state.rules.movePP(p, m.name);
    p.moves[m.name].pp = Math.max(0, Math.min(state.rules.moveMaxPP(p, m.name), cur + delta));
  });
  const details = h("details", { ontoggle: (e) => e.target.open ? state.openDetails.add(m.name) : state.openDetails.delete(m.name) },
    h("summary", {}, "Descrição"),
    h("div", {}, m.description ?? ""),
    m.scaling ? h("div", { style: "margin-top:4px" }, m.scaling) : null,
    m.table ? h("table", {}, h("tr", {}, m.table.Header.map((c) => h("th", {}, c))), m.table.Rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c))))) : null);
  if (state.openDetails.has(m.name)) details.open = true;
  return h("div", { class: "move", style: `border-left-color:${color}` },
    h("div", { class: "row" },
      h("span", { class: "title" }, m.label), typeTag(m.type), h("span", { class: "spacer" }),
      state.editable ? h("button", { class: "primary", disabled: noPP || state.busy, onclick: () => doMove(m.name, state.forceMove === m.name) }, state.forceMove === m.name ? "Usar mesmo assim" : "Usar") : null),
    h("div", { class: "meta" }, [m.time, m.range, m.duration].filter(Boolean).join(" · ")),
    state.forceMove === m.name && state.rangeMsg ? h("div", { class: "no small" }, state.rangeMsg) : null,
    h("div", { class: "nums" },
      m.attackBonus != null ? h("span", {}, "Acerto ", h("b", {}, signed(m.attackBonus))) : null,
      m.saveDC != null ? h("span", {}, "CD ", h("b", {}, m.saveDC), ` (${ATTR_PT[m.save] ?? m.save})`) : null,
      m.damage ? h("span", {}, "Dano ", h("b", {}, m.damageText), m.stab ? h("span", { class: "muted" }, " (STAB)") : null) : null,
      h("span", { class: "spacer" }),
      h("span", { class: "row", style: "flex-wrap:nowrap;gap:4px" },
        h("span", { class: noPP ? "no" : "" }, typeof m.pp === "number" ? `PP ${m.pp}/${m.ppMax}` : "PP ∞"),
        state.editable && typeof m.pp === "number" ? [h("button", { class: "icon", onclick: () => changePP(-1) }, "−"), h("button", { class: "icon", onclick: () => changePP(1) }, "+")] : null)),
    details);
}

// kept between renders so the dice animation isn't cut off by HP/PP updates
let resultCache = { entry: null, node: null };
function lastResult() {
  if (!state.last) return null;
  if (resultCache.entry !== state.last) resultCache = { entry: state.last, node: buildResult(state.last) };
  return resultCache.node;
}

function buildResult(e) {
  const animate = e._fresh === true;
  e._fresh = false;
  if (e.kind === "check") {
    return h("div", { class: "result row" }, die(e.nat, { animate, kind: e.nat === 20 ? "crit" : e.nat === 1 ? "fumble" : "" }), describe(e));
  }
  const lines = (e.results ?? []).map((r) => {
    if (!r.target) return h("div", {}, r.note);
    const nat = r.attack?.nat ?? (r.save && !r.save.unknown ? r.save.nat : null);
    const bits = [nat != null ? die(nat, { animate, kind: r.attack?.crit ? "crit" : r.attack?.fumble ? "fumble" : "" }) : null, " ", h("b", {}, r.target), ": "];
    if (r.attack) bits.push(h("span", { class: r.attack.hit ? "ok" : "no" }, r.attack.crit ? "CRÍTICO" : r.attack.hit ? "acertou" : "errou"), ` (d20 ${r.attack.nat} → ${r.attack.total}${r.attack.ac != null ? ` vs CA ${r.attack.ac}` : ""}) `);
    if (r.save) bits.push(r.save.effectOnly ? "efeito secundário: " : "", r.save.unknown ? `TR ${r.save.attr} CD ${r.save.dc} (alvo sem ficha, role na mesa) ` : h("span", { class: r.save.success ? "no" : "ok" }, `TR ${r.save.attr} ${r.save.total} vs CD ${r.save.dc} ${r.save.success ? "passou" : "falhou"} `));
    if (r.damage) bits.push(h("b", {}, `${r.damage.final} de dano`), ` [${r.damage.dice.map((x) => x.join("+")).join(" | ")}]${r.damage.effLabel ? ` ${r.damage.effLabel}` : ""}${r.damage.half ? " (metade)" : ""}`);
    if (r.hpAfter) bits.push(` → HP ${r.hpAfter}`);
    return h("div", {}, bits);
  });
  return h("div", { class: "result" }, h("div", { class: "muted small" }, `${e.move}${e.pp ? ` · PP ${e.pp}` : ""}`), lines);
}

async function rollCheck(label, bonus) {
  const settings = await getSettings();
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  const { nat } = await roller.d20(bonus, `${state.item.name} ${label}`);
  const entry = { kind: "check", attacker: state.item.name, label, nat, bonus, total: nat + bonus, roller: roller.name, _fresh: roller.name !== "Dice+" };
  state.last = entry;
  render();
  await pushLog(entry);
}

async function doMove(name, ignoreRange, areaTargets) {
  const m = state.rules.moveData(getSheet(state.item).pkmn, name);
  if (m.rangeInfo.kind === "area" && !areaTargets) {
    state.aiming = name;
    OBR.notification.show(`${m.label}: mire a área no mapa e clique pra usar (Esc cancela).`, "INFO");
    await OBR.broadcast.sendMessage(AIM_START, { attackerId: itemId, moveName: name, shape: m.rangeInfo.shape, meters: m.rangeInfo.meters, label: `${m.label.replace(/ PMP$/, "")} (${m.rangeInfo.label})` }, { destination: "LOCAL" });
    return;
  }
  state.busy = true;
  render();
  try {
    if (areaTargets) state.targets = areaTargets;
    else await refreshTargets();
    state.last = await useMove(state.rules, state.item, name, state.targets, { ignoreRange, area: !!areaTargets });
    state.last._fresh = state.last.roller !== "Dice+";
    state.forceMove = null;
    state.rangeMsg = null;
  } catch (e) {
    if (e instanceof OutOfRange) {
      state.forceMove = name;
      state.rangeMsg = e.message;
    } else OBR.notification.show(e.message, "ERROR");
  } finally {
    state.busy = false;
    render();
  }
}

function footer(pkmn) {
  const { rules } = state;
  return h("div", { class: "row", style: "margin-top:12px" },
    state.editable ? h("button", {
      title: "HP cheio, PP restaurado e status limpos",
      onclick: async () => {
        await updatePokemon(itemId, (p) => {
          p.hp.current = rules.maxHP(p);
          p.hp.temp = 0;
          for (const n of Object.keys(p.moves ?? {})) p.moves[n].pp = rules.moveMaxPP(p, n);
          p.statuses = {};
        });
        await pushLog({ kind: "note", attacker: state.item.name, text: "fez um descanso longo" });
      },
    }, "Descansar") : null,
    h("button", {
      title: "Copia a ficha atualizada (HP, PP, status) pra importar de volta no app",
      onclick: async () => {
        const text = JSON.stringify(pkmn);
        try {
          await navigator.clipboard.writeText(text);
          OBR.notification.show("Ficha copiada! Importe no app pela área de transferência.", "SUCCESS");
        } catch {
          state.exportText = text;
          render();
        }
      },
    }, "Exportar"),
    h("span", { class: "spacer" }),
    state.editable ? h("button", {
      class: state.confirmRemove ? "primary" : "",
      onclick: async () => {
        if (!state.confirmRemove) {
          state.confirmRemove = true;
          render();
          setTimeout(() => { state.confirmRemove = false; render(); }, 4000);
          return;
        }
        await OBR.scene.items.updateItems([itemId], (ds) => { for (const x of ds) delete x.metadata[SHEET_KEY]; });
        OBR.popover.close(`${ID}/sheet`);
      },
    }, state.confirmRemove ? "Confirmar remoção" : "Remover ficha") : null);
}

function exportBox() {
  if (!state.exportText) return null;
  const ta = h("textarea", { rows: "5", readonly: true }, state.exportText);
  setTimeout(() => ta.select(), 0);
  return h("div", { class: "card" }, h("h2", {}, "Copie o código (Ctrl+C)"), ta,
    h("div", { class: "row", style: "margin-top:6px" }, h("span", { class: "spacer" }), h("button", { onclick: () => { state.exportText = null; render(); } }, "Fechar")));
}

function render() {
  const sheet = getSheet(state.item);
  const title = document.getElementById("title");
  if (!sheet) {
    title.textContent = state.item?.name ?? "Token";
    root.replaceChildren(h("div", { class: "empty" }, "Este token não tem ficha do PMP."));
    return;
  }
  const pkmn = sheet.pkmn;
  const { rules } = state;
  title.textContent = `${state.item.name || rules.name(pkmn)} · Nv ${rules.level(pkmn)}`;
  const scroll = root.scrollTop;
  root.replaceChildren(...[
    h("div", { class: "muted small" }, `${pkmn.species.current}${pkmn.variant && pkmn.variant !== pkmn.species.current ? ` (${pkmn.variant})` : ""}${state.editable ? "" : " · só leitura"}`),
    hpCard(pkmn),
    statsCard(pkmn),
    infoCard(pkmn),
    targetsCard(),
    lastResult(),
    h("div", { class: "card" }, h("h2", {}, "Moves"), rules.moveList(pkmn).map(moveCard)),
    footer(pkmn),
    exportBox(),
  ].filter(Boolean));
  root.scrollTop = scroll;
}

OBR.onReady(async () => {
  syncTheme();
  document.getElementById("close").onclick = () => OBR.popover.close(`${ID}/sheet`);
  state.rules = await loadRules();
  state.item = await getItem(itemId);
  state.editable = await canEdit(getSheet(state.item));
  await refreshTargets();
  render();
  OBR.scene.items.onChange(async (items) => {
    const it = items.find((i) => i.id === itemId);
    if (!it) return OBR.popover.close(`${ID}/sheet`);
    state.item = it;
    state.targets = state.targets.map((t) => items.find((i) => i.id === t.id)).filter(Boolean);
    render();
  });
  OBR.player.onChange(async (player) => {
    await refreshTargets(player.selection ?? []);
    render();
  });
  OBR.broadcast.onMessage(AIM_DONE, async ({ data }) => {
    if (state.aiming !== data.moveName || data.attackerId !== itemId) return;
    state.aiming = null;
    const targets = data.targetIds.length ? await OBR.scene.items.getItems(data.targetIds) : [];
    await doMove(data.moveName, true, targets);
  });
  OBR.broadcast.onMessage(AIM_CANCEL, () => { state.aiming = null; });
});
