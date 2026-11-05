// Quick sheet: opens when a controllable Pokémon is selected. HP + moves; pick a move,
// click the targets on the map, then roll. Initiative goes to Pretty Sordid.
import { OBR, ID, HUD_ID, loadRules, getSheet, getItem, updatePokemon, canEdit, h, syncTheme } from "./store.js?v=0.7.0";
import { TYPE_PT, ATTR_PT, signed, fmtM } from "./rules.js?v=0.7.0";
import { useMove, TurnError } from "./combat.js?v=0.7.0";
import { TYPE_COLOR, openSheet, openHud, openStages, hudPosition, saveHudPosition, die, markHudAlive } from "./ui.js?v=0.7.0";
import { checkRange, OutOfRange, rollInitiative, initiativeOf, distanceMeters } from "./map.js?v=0.7.0";
import { AIM_ABORT, AIM_STALE, requestAim, aimState } from "./area.js?v=0.7.0";
import { CONDITIONS, STAGE_SHORT, conditionsOf, econOf, inInitiative, moveTiming, has, chooseCost, allies, canSeeFull, ampPoints, redPoints } from "./battle.js?v=0.7.0";
import { seesTarget } from "./combat.js?v=0.7.0";

const HELPING_HAND = "Helping Hand";

const root = document.getElementById("root");
const state = {
  rules: null,
  attackerId: new URLSearchParams(location.search).get("id"),
  item: null,
  mode: "idle", // "idle" | "target"
  pending: null, // move name waiting for targets
  targets: [],
  ranges: new Map(), // targetId -> { meters, ok, reason }
  outOfRange: null, // OutOfRange error waiting for "roll anyway"
  last: null, // last move result or initiative roll
  busy: false,
};

async function setAttacker(id) {
  state.attackerId = id;
  state.item = await getItem(id);
  Object.assign(state, { mode: "idle", pending: null, targets: [], ranges: new Map(), outOfRange: null, last: null });
}

async function updateRanges() {
  state.ranges = new Map();
  if (!state.pending || !state.targets.length) return;
  const move = state.rules.moveData(getSheet(state.item).pkmn, state.pending);
  for (const r of await checkRange(state.item, move, state.targets)) state.ranges.set(r.id, r);
}

async function onSelection(selection) {
  const ids = selection ?? [];
  if (state.mode === "aim") return; // the area tool picks the targets
  if (state.mode === "target") {
    const others = ids.filter((id) => id !== state.attackerId);
    state.targets = others.length ? await OBR.scene.items.getItems(others) : [];
    state.outOfRange = null;
    await updateRanges();
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
  const sheet = getSheet(state.item);
  const cond = conditionsOf(sheet);
  const stages = Object.entries(pkmn.stages ?? {}).filter(([, v]) => v);
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
      h("span", { class: "spacer" })),
    Object.keys(cond).length || stages.length || sheet.battle?.helped || ampPoints(pkmn) || redPoints(pkmn)
      ? h("div", { class: "row", style: "margin-top:4px;gap:4px" },
          sheet.battle?.helped ? h("span", { class: "chip up", title: "Vale só pro próximo ataque (ou até o fim da rodada)" }, `🤝 Helping Hand de ${sheet.battle.helped.by}`) : null,
          Object.entries(cond).map(([k, v]) => h("span", { class: "chip cond", title: condTip(k, v) }, `${CONDITIONS[k]?.icon ?? ""} ${CONDITIONS[k]?.label ?? k}`)),
          stages.map(([k, v]) => h("span", { class: `chip ${v > 0 ? "up" : "down"}` }, `${STAGE_SHORT[k] ?? k} ${v > 0 ? "+" : ""}${v}`)),
          ampPoints(pkmn) ? h("span", { class: "chip up" }, `Amp ${String(ampPoints(pkmn)).replace(".", ",")}`) : null,
          redPoints(pkmn) ? h("span", { class: "chip down" }, `Red ${String(redPoints(pkmn)).replace(".", ",")}`) : null)
      : null);
}

function condTip(key, v) {
  if (key === "Confused") return `Confuso: mais ${v.left ?? "?"} turno(s)`;
  if (key === "BadlyPoisoned") return `Gravemente Envenenado: próximo dano ×${v.count ?? 1}`;
  if (key === "Asleep") return `Dormindo há ${v.age ?? 0} turno(s)`;
  if (key === "Frozen") return `Congelado há ${v.age ?? 0} turno(s)`;
  if (key === "Drowsy") return v.blocked ? "Sonolento: não usa Moves neste turno" : "Sonolento";
  return CONDITIONS[key]?.label ?? key;
}

function initiativeBlock(pkmn) {
  const init = initiativeOf(state.item);
  const econ = econOf(getSheet(state.item));
  const slot = (key, label) => h("span", { class: `slot ${econ[key] ? "on" : "off"}`, title: econ[key] ? `${label} disponível` : `${label} já usada` }, label);
  return h("div", { class: `row hud-init ${init?.active ? "turn" : ""}` },
    init?.active ? h("b", { class: "turn-tag" }, "▶ SUA VEZ") : null,
    h("span", { class: "muted small" }, init ? `Init ${init.count}` : "Fora da iniciativa"),
    inInitiative(state.item) ? [slot("action", "Ação"), slot("bonus", "Bônus"), slot("reaction", "Reação")] : null,
    h("span", { class: "spacer" }),
    h("button", {
      class: "small",
      disabled: state.busy,
      title: `d20 ${signed(state.rules.initiative(pkmn))} (DES${state.rules.featCount(pkmn, "Alerta") ? " + Alerta" : ""}), entra no Pretty Sordid`,
      onclick: async () => {
        state.busy = true;
        render();
        try { state.last = await rollInitiative(state.rules, state.item); state.last._fresh = state.last.roller !== "Dice+"; }
        catch (e) { OBR.notification.show(e.message, "ERROR"); }
        finally { state.busy = false; render(); }
      },
    }, `🎲 ${signed(state.rules.initiative(pkmn))}`));
}

// "A" action, "B" bonus action, "R" reaction: what the move can spend
function timingTag(name) {
  const t = moveTiming(state.rules.moves[name] ?? {});
  const tags = [t.action || t.both ? "A" : null, t.bonus ? "B" : null, t.reaction ? "R" : null].filter(Boolean);
  return h("span", { class: "tt", title: state.rules.moves[name]?.["Move Time"] ?? "" }, tags.join("/") || "A");
}

function moveRow(m) {
  const noPP = typeof m.pp === "number" && m.pp <= 0;
  const nums = [
    m.attackBonus != null ? `Acerto ${signed(m.attackBonus)}` : null,
    m.saveDC != null ? `CD ${m.saveDC} ${ATTR_PT[m.save] ?? m.save}` : null,
    m.damage ? m.damageText : null,
    m.rangeInfo.kind !== "any" ? m.rangeInfo.label : null,
  ].filter(Boolean).join(" · ");
  const selected = state.pending === m.name;
  return h("button", {
    class: `hud-move ${selected ? "sel" : ""}`,
    style: `--type:${TYPE_COLOR[m.type] ?? "#777"}`,
    disabled: noPP || state.busy,
    title: `${TYPE_PT[m.type] ?? m.type} · ${[m.time, m.range].filter(Boolean).join(" · ")}`,
    onclick: async () => {
      state.pending = m.name;
      state.outOfRange = null;
      if (m.rangeInfo.kind === "area") {
        // turn/action check first, so nobody aims for nothing
        try {
          const running = (await OBR.scene.items.getItems((i) => i.metadata?.["com.pretty-initiative/metadata"]?.active === true)).length > 0;
          chooseCost(state.item, state.rules.moves[m.name] ?? {}, running);
          state.forceArea = false;
        } catch (e) {
          if (!(e instanceof TurnError)) throw e;
          if (!state.isGM) { OBR.notification.show(e.message, "WARNING"); state.pending = null; return render(); }
          OBR.notification.show(`${e.message} (mestre: vai mesmo assim)`, "WARNING");
          state.forceArea = true;
        }
        // the template appears on the map; whoever is inside when the player clicks gets hit
        state.mode = "aim";
        state.targets = [];
        render();
        state.aimNonce = null;
        const nonce = await requestAim({ attackerId: state.attackerId, moveName: m.name, shape: m.rangeInfo.shape, meters: m.rangeInfo.meters, label: `${m.label.replace(/ PMP$/, "")} (${m.rangeInfo.label})` });
        if (nonce) {
          state.aimNonce = nonce;
          await onAim(aimState({ metadata: await OBR.player.getMetadata() })); // in case it already finished
        } else if (state.mode === "aim") {
          OBR.notification.show(AIM_STALE, "WARNING");
          Object.assign(state, { mode: "idle", pending: null });
          render();
        }
        return;
      }
      if (m.rangeInfo.kind === "self") {
        // "Pessoal" (Swords Dance, Agility...): no targets to pick
        state.mode = "self";
        state.targets = [];
        state.turnError = null;
        await roll(true);
        return;
      }
      state.mode = "target";
      state.turnError = null;
      const sel = ((await OBR.player.getSelection()) ?? []).filter((id) => id !== state.attackerId);
      state.targets = sel.length ? await OBR.scene.items.getItems(sel) : [];
      await updateRanges();
      await findHelpers(m);
      render();
    },
  },
    h("span", { class: "hud-move-name" }, timingTag(m.name), " ", m.label.replace(/ PMP$/, "")),
    h("span", { class: "hud-move-nums" }, nums || "sem rolagem"),
    h("span", { class: `hud-move-pp ${noPP ? "no" : ""}` }, typeof m.pp === "number" ? `${m.pp}/${m.ppMax}` : "∞"));
}

// allies this player controls that can use Helping Hand on this attack (reaction, 18 m)
async function findHelpers(m) {
  state.helperCands = [];
  state.helpers = new Set();
  if (m.attackBonus == null && !m.damage) return;
  const items = await OBR.scene.items.getItems((i) => i.metadata?.["com.pmp-fichas/sheet"]?.pkmn?.moves?.[HELPING_HAND] && i.id !== state.attackerId);
  for (const it of items) {
    const s = getSheet(it);
    if (!(await canEdit(s)) || !allies(s, getSheet(state.item))) continue; // your own Pokémon on the same team
    const pp = state.rules.movePP(s.pkmn, HELPING_HAND);
    let reason = "";
    if (s.pkmn.hp.current <= 0) reason = "desmaiado";
    else if (typeof pp === "number" && pp <= 0) reason = "sem PP";
    else if (inInitiative(it) && !econOf(s).reaction) reason = "reação já usada";
    else if (has(s, "Confused") || has(s, "Asleep") || has(s, "Frozen") || has(s, "Stunned")) reason = "não pode reagir";
    else if ((await distanceMeters(it, state.item)) > 18.05) reason = "longe (mais de 18 m)";
    state.helperCands.push({ item: it, reason });
  }
}

function helpersRow() {
  if (!state.helperCands?.length) return null;
  return h("div", { class: "row small", style: "margin:2px 0 4px;gap:4px" },
    h("span", { class: "muted" }, "Helping Hand:"),
    state.helperCands.map(({ item, reason }) => h("span", {
      class: `chip ${state.helpers.has(item.id) ? "on" : ""} ${reason ? "far" : ""}`,
      style: reason ? "opacity:.6" : "cursor:pointer",
      title: reason || "Gasta a reação deste Pokémon: +1d6 no acerto e mais dados de dano",
      onclick: reason ? null : () => { state.helpers.has(item.id) ? state.helpers.delete(item.id) : state.helpers.add(item.id); render(); },
    }, `🤝 ${item.name}${reason ? ` (${reason})` : ""}`)));
}

function targetBar() {
  if (state.mode !== "target") return null;
  const move = state.rules.moveData(getSheet(state.item).pkmn, state.pending);
  const cancel = () => { Object.assign(state, { mode: "idle", pending: null, targets: [], ranges: new Map(), outOfRange: null }); render(); };
  return h("div", { class: "hud-target" },
    h("div", { class: "small" }, h("b", {}, move.label.replace(/ PMP$/, "")), ` · alcance ${move.rangeInfo.label}`),
    h("div", { class: "small muted" }, "Clique nos alvos no mapa (Shift+clique pra vários)."),
    h("div", { class: "targets", style: "margin:4px 0" },
      state.targets.length
        ? state.targets.map((t) => {
            const p = getSheet(t)?.pkmn;
            const r = state.ranges.get(t.id);
            return h("span", { class: `chip on ${r && !r.ok ? "far" : ""}`, title: r?.reason ?? "" },
              t.name || "Token",
              p && canSeeFull(getSheet(t), state.viewer) ? ` · CA ${state.rules.ac(p)}` : "",
              r?.meters != null ? ` · ${fmtM(r.meters)}` : "",
              r ? (r.ok ? " ✓" : " ✗") : "");
          })
        : h("span", { class: "muted small" }, "Nenhum alvo: rola só o dano.")),
    helpersRow(),
    state.outOfRange
      ? h("div", { class: "no small", style: "margin-bottom:4px" }, state.outOfRange.message)
      : null,
    state.turnError
      ? h("div", { class: "no small", style: "margin-bottom:4px" }, state.turnError)
      : null,
    h("div", { class: "row" },
      state.turnError && state.isGM
        ? h("button", { class: "primary", disabled: state.busy, onclick: () => roll(true, false, true) }, "Usar mesmo assim (mestre)")
        : state.outOfRange
          ? h("button", { class: "primary", disabled: state.busy, onclick: () => roll(true) }, "Rolar mesmo assim")
          : h("button", { class: "primary", disabled: state.busy || (state.turnError && !state.isGM), onclick: () => roll(false) }, state.busy ? "Rolando…" : "Rolar"),
      h("button", { onclick: cancel }, "Cancelar")));
}

// the last result, with the dice tumbling the first time it shows. The node is kept between
// renders so the animation isn't cut off when HP/PP updates re-render the HUD.
let resultCache = { entry: null, node: null };
function resultBlock() {
  const e = state.last;
  if (!e || state.mode === "target") return null;
  if (resultCache.entry === e) return resultCache.node;
  resultCache = { entry: e, node: buildResult(e) };
  return resultCache.node;
}

function buildResult(e) {
  const animate = e._fresh === true;
  e._fresh = false;
  if (e.kind === "check") {
    return h("div", { class: "hud-result row" },
      die(e.nat, { animate, kind: e.nat === 20 ? "crit" : e.nat === 1 ? "fumble" : "" }),
      h("span", {}, `${e.label}: `, h("b", {}, e.total), h("span", { class: "muted" }, ` (${e.nat}${signed(e.bonus)})`)));
  }
  return h("div", { class: "hud-result" },
    h("div", { class: "muted small" }, [e.move, e.cost, ...(e.notes ?? [])].filter(Boolean).join(" · ")),
    e.checks?.length ? h("div", { class: "row small", style: "gap:4px" }, e.checks.map((c) => h("span", { class: c.failed ? "no" : "ok" }, `${c.label}: ${c.nat}`))) : null,
    e.results.map((r) => {
      if (!r.target) return h("div", { class: e.failed ? "no" : "" }, r.note);
      const bits = [];
      if (r.attack) bits.push(die(r.attack.nat, { animate, kind: r.attack.crit ? "crit" : r.attack.fumble ? "fumble" : "" }));
      else if (r.save && !r.save.unknown) bits.push(die(r.save.nat, { animate }));
      bits.push(h("b", {}, r.target), " ");
      const full = seesTarget(r, state.viewer);
      if (r.attack) bits.push(h("span", { class: r.attack.hit ? "ok" : "no" }, r.attack.crit ? "CRÍTICO" : r.attack.hit ? "acertou" : "errou"), ` (${r.attack.total}${r.attack.ac != null && full ? ` vs ${r.attack.ac}` : ""}) `);
      if (r.save && !r.save.unknown) bits.push(h("span", { class: r.save.success ? "no" : "ok" }, `${r.save.effectOnly ? "efeito: " : ""}TR ${r.save.total} vs ${r.save.dc} ${r.save.success ? "passou" : "falhou"} `));
      if (r.save?.unknown) bits.push(`TR ${r.save.attr} CD ${r.save.dc} `);
      if (r.contest) bits.push(h("span", { class: r.contest.success ? "ok" : "no" }, r.contest.auto ? "acerto automático " : `${r.contest.total} vs ${r.contest.vs} ${r.contest.success ? "pegou" : "resistiu"} `));
      if (r.damage) {
        bits.push(h("b", {}, `${r.damage.final} dano`), r.damage.effLabel ? ` ${r.damage.effLabel}` : "");
      }
      if (r.hpAfter && full) bits.push(h("span", { class: "muted" }, ` → ${r.hpAfter}`));
      if (r.effects?.length) bits.push(h("span", { class: "warn" }, ` · ${r.effects.join(", ")}`));
      const dmgDice = r.damage?.dice.flat().length
        ? h("div", { class: "dice-row" }, r.damage.dice.flat().map((v) => die(v, { sides: r.damage.sides ?? 6, animate })),
            r.damage.bonus ? h("span", { class: "muted small" }, signed(r.damage.bonus)) : null)
        : null;
      return h("div", { class: "hud-res-line" }, h("div", { class: "row", style: "gap:4px" }, bits), dmgDice);
    }));
}

// the background finished (or cancelled) the aim this sheet asked for
async function onAim(s) {
  if (!s || state.mode !== "aim" || !state.aimNonce || s.nonce !== state.aimNonce) return;
  if (s.status === "done") {
    state.aimNonce = null;
    state.targets = s.targetIds.length ? await OBR.scene.items.getItems(s.targetIds) : [];
    await roll(true, true, !!state.forceArea);
  } else if (s.status === "cancel") {
    state.aimNonce = null;
    Object.assign(state, { mode: "idle", pending: null, targets: [] });
    render();
  }
}

function aimBar() {
  if (state.mode !== "aim") return null;
  const move = state.rules.moveData(getSheet(state.item).pkmn, state.pending);
  return h("div", { class: "hud-target" },
    h("div", { class: "small" }, h("b", {}, move.label.replace(/ PMP$/, "")), ` · ${move.rangeInfo.label}`),
    h("div", { class: "small muted" }, state.busy ? "Rolando…" : "Mova o mouse no mapa pra mirar. Clique pra usar em todos dentro da área. Esc cancela."),
    h("div", { class: "row", style: "margin-top:4px" },
      h("button", { disabled: state.busy, onclick: () => OBR.broadcast.sendMessage(AIM_ABORT, {}, { destination: "LOCAL" }) }, "Cancelar")));
}

async function roll(ignoreRange, area = false, force = false) {
  state.busy = true;
  render();
  try {
    state.item = await getItem(state.attackerId);
    const helpers = state.helperCands?.filter((c) => state.helpers?.has(c.item.id)).map((c) => c.item) ?? [];
    state.last = await useMove(state.rules, state.item, state.pending, state.targets, { ignoreRange, area, force, helpers });
    state.last._fresh = state.last.roller !== "Dice+";
    Object.assign(state, { mode: "idle", pending: null, targets: [], ranges: new Map(), outOfRange: null, turnError: null, helperCands: [], helpers: new Set() });
    await OBR.player.select([state.attackerId], true); // back to the attacker
  } catch (e) {
    if (e instanceof OutOfRange) state.outOfRange = e;
    else if (e instanceof TurnError) {
      // out of turn / action already used: players are blocked, the GM may force it
      state.turnError = e.message;
      if (state.mode !== "target") { OBR.notification.show(e.message, "WARNING"); if (!state.isGM) Object.assign(state, { mode: "idle", pending: null }); else state.mode = "target"; }
    } else {
      OBR.notification.show(e.message, "ERROR");
      Object.assign(state, { mode: "idle", pending: null, targets: [] });
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function close() {
  clearInterval(heartbeat);
  markHudAlive(false);
  await OBR.broadcast.sendMessage(`${ID}/hud-closed`, {}, { destination: "LOCAL" });
  await OBR.popover.close(HUD_ID);
}

// tells the background this quick sheet is open (see markHudAlive in ui.js)
markHudAlive();
const heartbeat = setInterval(markHudAlive, 1000);
addEventListener("pagehide", () => markHudAlive(false));

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
      h("span", { class: "drag", title: "Arraste pra mudar a ficha rápida de lugar", onpointerdown: startDrag }, "⠿"),
      h("b", { class: "hud-name" }, state.item.name || rules.name(pkmn)),
      h("span", { class: "muted small" }, `Nv ${rules.level(pkmn)}`),
      rules.types(pkmn).map((t) => h("span", { class: "dot", style: `background:${TYPE_COLOR[t]}`, title: TYPE_PT[t] })),
      h("span", { class: "spacer" }),
      h("button", { class: "icon", title: "Mudanças de Status (estágios e pontos de dano)", onclick: () => openStages(state.attackerId) }, "📊"),
      h("button", { class: "icon", title: "Ficha completa", onclick: () => openSheet(state.attackerId) }, "☰"),
      h("button", { class: "icon", title: "Fechar", onclick: close }, "✕")),
    hpBlock(pkmn),
    initiativeBlock(pkmn),
    targetBar(),
    aimBar(),
    h("div", { class: "hud-moves" }, rules.moveList(pkmn).map(moveRow)),
    resultBlock()));
  fit();
}

// Dragging: Owlbear can't move an open popover, so the quick sheet follows the pointer with a hint
// and, on release, reopens at the new spot (remembered in this browser).
function startDrag(ev) {
  ev.preventDefault();
  const handle = ev.currentTarget;
  handle.setPointerCapture(ev.pointerId);
  const start = { x: ev.screenX, y: ev.screenY };
  document.body.classList.add("dragging");
  const move = (e) => { document.body.dataset.drag = `${Math.round(e.screenX - start.x)}, ${Math.round(e.screenY - start.y)}`; };
  const up = async (e) => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    document.body.classList.remove("dragging");
    const dx = e.screenX - start.x, dy = e.screenY - start.y;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    const height = await OBR.viewport.getHeight();
    const pos = hudPosition(height);
    saveHudPosition({ left: Math.round(pos.left + dx), bottom: Math.round(pos.bottom + dy) });
    markHudAlive();
    await openHud(state.attackerId);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

// grow/shrink the popover to its content
function fit() {
  requestAnimationFrame(() => {
    const height = Math.min(640, Math.ceil(root.getBoundingClientRect().height) + 2);
    OBR.popover.setHeight(HUD_ID, height).catch(() => {});
  });
}

OBR.onReady(async () => {
  syncTheme();
  state.rules = await loadRules();
  state.isGM = (await OBR.player.getRole()) === "GM";
  state.viewer = { id: OBR.player.id, role: state.isGM ? "GM" : "PLAYER" };
  await setAttacker(state.attackerId);
  render();
  OBR.scene.items.onChange(async (items) => {
    const it = items.find((i) => i.id === state.attackerId);
    if (it) state.item = it;
    state.targets = state.targets.map((t) => items.find((i) => i.id === t.id)).filter(Boolean);
    if (state.mode === "target") await updateRanges();
    render();
  });
  OBR.player.onChange((p) => { onAim(aimState(p)); onSelection(p.selection); });
});
