// Quick sheet: opens when a controllable Pokémon is selected. HP + moves; pick a move,
// click the targets on the map, then roll. Initiative goes to Pretty Sordid.
import { OBR, ID, HUD_ID, loadRules, getSheet, getItem, updatePokemon, updateSheet, canEdit, h, syncTheme, pushLog } from "./store.js?v=0.9.7";
import { TYPE_PT, ATTR_PT, signed, fmtM } from "./rules.js?v=0.9.7";
import { useMove, TurnError, throwAttack, THROW, throwRange, grapple, escapeGrapple, releaseGrapple } from "./combat.js?v=0.9.7";
const GRAB = "__grab";
import { TYPE_COLOR, openSheet, openHud, openStages, openTrainer, hudPosition, saveHudPosition, hudTop, hudRoom, saveHudHeight, die, markHudAlive } from "./ui.js?v=0.9.7";
import { rollPending } from "./trainer.js?v=0.9.7";
import { checkRange, OutOfRange, rollInitiative, initiativeOf, distanceMeters } from "./map.js?v=0.9.7";
import { AIM_ABORT, AIM_STALE, requestAim, aimState } from "./area.js?v=0.9.7";
import { CONDITIONS, STAGE_SHORT, conditionsOf, econOf, inInitiative, isActive, moveTiming, has, chooseCost, allies, canSeeFull, ampPoints, redPoints, passTurn, processTurn } from "./battle.js?v=0.9.7";
import { runPrepared } from "./prepared.js?v=0.9.7";
import { fieldNow, fieldText } from "./field.js?v=0.9.7";
import { seesTarget } from "./combat.js?v=0.9.7";
import { special, chargingOf, invulnOf, invulnText, invulnCheck, releaseReady, movement, jumps, jumpOpts, dash, changeAltitude, disengage, oaMoves } from "./tactics.js?v=0.9.7";

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

// the move being aimed (Arremessar is not a move of the sheet)
function pendingMove() {
  const pkmn = getSheet(state.item).pkmn;
  if (state.pending === THROW) {
    const m = throwRange(state.rules, pkmn);
    return { name: THROW, label: "Arremessar", rangeInfo: { kind: "ranged", meters: m, label: fmtM(m) } };
  }
  if (state.pending === GRAB) {
    const r = state.rules.reach(pkmn);
    return { name: GRAB, label: "Agarrar", rangeInfo: { kind: "melee", meters: r, label: `corpo a corpo (${fmtM(r)})` } };
  }
  return state.rules.moveData(pkmn, state.pending);
}

// Arremessar with 2 tokens: which one is thrown? (the one picked with ⇄, else an ally / one it grapples)
function throwRoles() {
  if (state.pending !== THROW || state.targets.length !== 2) return { creature: null, target: state.targets[0] ?? null };
  const mine = getSheet(state.item);
  const fit = (t) => { const s = getSheet(t); return !s || s.pkmn.hp.current <= 0 || allies(mine, s) || s.battle?.cond?.Grappled?.by === state.attackerId; };
  let creature = state.targets.find((t) => t.id === state.throwCreature) ?? state.targets.find(fit) ?? state.targets[0];
  return { creature, target: state.targets.find((t) => t.id !== creature.id) };
}

async function updateRanges() {
  state.ranges = new Map();
  if (!state.pending || !state.targets.length) return;
  const move = pendingMove();
  if (state.pending === THROW && state.targets.length === 2) {
    // range counts to the target; the creature has to be within reach
    const { creature, target } = throwRoles();
    const [r] = await checkRange(state.item, move, [target]);
    state.ranges.set(target.id, r);
    const d = Math.round((await distanceMeters(state.item, creature)) * 10) / 10;
    const reach = state.rules.reach(getSheet(state.item).pkmn);
    state.ranges.set(creature.id, { id: creature.id, meters: d, ok: d <= reach + 0.05, reason: d <= reach + 0.05 ? "" : `precisa estar a ${fmtM(reach)}`, role: "creature" });
    return;
  }
  const ch = chargingOf(getSheet(state.item));
  // Fly/Dig...: counted from where the move was activated
  const from = ch?.invuln && ch.move === state.pending && ch.from ? { ...state.item, position: ch.from, metadata: {} } : state.item;
  const jump = move.rangeInfo.kind === "melee" ? await jumpOpts(state.rules, state.item) : null;
  for (const r of await checkRange(from, move, state.targets, { jump })) {
    const inv = invulnCheck(getSheet(state.targets.find((t) => t.id === r.id)), state.pending);
    state.ranges.set(r.id, inv?.blocked ? { ...r, ok: false, reason: inv.reason, invuln: true } : r);
  }
}

const running = async () => (await OBR.scene.items.getItems((i) => i.metadata?.["com.pretty-initiative/metadata"]?.active === true)).length > 0;

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
    econ.loseAction ? h("span", { class: "chip down", title: "Usou uma reação que adianta o turno: o próximo turno começa sem a ação padrão" }, "−Ação próx.") : null,
    h("span", { class: "spacer" }),
    init?.active ? h("button", { class: "small", disabled: state.busy, title: "Passa a vez pro próximo da iniciativa", onclick: () => act(async () => {
      await passTurn(state.attackerId);
      // end/start of turn right here (the GM's browser would do it too, but this way it never waits on it)
      await processTurn(state.rules, { onTurnStart: (it) => runPrepared(state.rules, it), onNewRound: () => rollPending(state.rules) });
    }) }, "⏭ Passar") : null,
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

// runs a button's action with the busy flag; errors become notifications
async function act(fn) {
  state.busy = true;
  render();
  try { await fn(); }
  catch (e) { OBR.notification.show(e.message, e instanceof TurnError ? "WARNING" : "ERROR"); }
  finally { state.busy = false; state.item = await getItem(state.attackerId); render(); }
}

// movement this turn, Disparada, flight, jumps, throwing
function moveBlock() {
  const { rules } = state;
  const mv = movement(rules, state.item);
  const j = jumps(rules, state.item);
  const tracking = mv.tracking && state.running;
  const mine = isActive(state.item);
  const econ = econOf(getSheet(state.item));
  const speeds = [mv.walk ? `andar ${fmtM(mv.walk)}` : null, mv.fly ? `voo ${fmtM(mv.fly)}` : null, mv.swim ? `nado ${fmtM(mv.swim)}` : null].filter(Boolean).join(" · ");
  return h("div", { class: "row hud-moverow small", style: "gap:4px;margin:2px 0" },
    tracking
      ? h("span", { class: `chip ${mv.left <= 0 ? "down" : ""}`, title: `${speeds}${mv.why ? ` · ${mv.why}` : ""}${mv.dash ? " · Disparada" : ""}. Arraste o token no mapa: os metros saem daqui.` },
          `👣 ${fmtM(mv.used)} / ${fmtM(mv.budget)}`)
      : h("span", { class: "muted", title: mv.why || "" }, `👣 ${speeds || "sem deslocamento"}`),
    tracking ? h("button", {
      class: "small", disabled: state.busy || !mine || !econ.action || mv.dash,
      title: "Disparada: gasta a ação e dobra o deslocamento deste turno",
      onclick: () => act(() => dash(rules, state.item)),
    }, mv.dash ? "💨 Disparada" : "💨 Disparar") : null,
    mv.fly > 0 ? [
      h("span", { class: `chip ${mv.alt >= 3 ? "up" : ""}`, title: mv.alt >= 3 ? "Elevado (3 m ou mais): imune a Moves de Terra; ataques à distância além da metade do alcance com desvantagem" : "Abaixo de 3 m não conta como Elevado" }, `✈ ${fmtM(mv.alt)}`),
      h("button", { class: "small icon", disabled: state.busy, title: "Voar 1,5 m pra cima (gasta 1,5 m de deslocamento)", onclick: () => act(() => changeAltitude(rules, state.item, 1.5)) }, "▲"),
      h("button", { class: "small icon", disabled: state.busy || mv.alt <= 0, title: "Descer 1,5 m (gasta 1,5 m de deslocamento)", onclick: () => act(() => changeAltitude(rules, state.item, -1.5)) }, "▼"),
    ] : null,
    h("span", { class: "spacer" }),
    mv.alt === 0 ? h("span", { class: "muted", title: `Salto em altura ${fmtM(j.high)}, em distância ${fmtM(j.long)} (${j.ran ? "com corrida" : "parado: metade; ande 3 m antes pra saltar o dobro"}). Num Move corpo a corpo contra um voador, o pulo é automático e gasta deslocamento.` }, `🦘 ${fmtM(j.high)}`) : null);
}

// actions that aren't moves: throwing, grappling, Desengajar
function actionsBlock() {
  const { rules } = state;
  const sheet = getSheet(state.item);
  const pkmn = sheet.pkmn;
  const tracking = inInitiative(state.item) && state.running;
  const mine = isActive(state.item);
  const econ = econOf(sheet);
  const pick = (kind) => async () => {
    Object.assign(state, { pending: kind, mode: "target", outOfRange: null, turnError: null, helperCands: [], helpers: new Set(), throwCreature: null });
    const sel = ((await OBR.player.getSelection()) ?? []).filter((id) => id !== state.attackerId);
    state.targets = sel.length ? await OBR.scene.items.getItems(sel) : [];
    await updateRanges();
    render();
  };
  const grabbed = conditionsOf(sheet).Grappled;
  return h("div", { class: "row hud-moverow small", style: "gap:4px;margin:2px 0" },
    h("button", {
      class: `small ${state.pending === THROW ? "primary" : ""}`, disabled: state.busy,
      title: `Arremessar (ação), até ${fmtM(throwRange(rules, pkmn))}. Marque 1 alvo pra jogar um objeto, ou 2 tokens: a criatura (ao seu alcance) e o alvo. Aliado não precisa de teste; inimigo precisa estar agarrado e vai metade da distância. Jogada num voador, a criatura fica no ar até o fim do próximo turno dela.`,
      onclick: pick(THROW),
    }, "🤾 Arremessar"),
    h("button", {
      class: `small ${state.pending === GRAB ? "primary" : ""}`, disabled: state.busy || !!sheet.battle?.grabbing,
      title: "Agarrar (ação): FOR (Atletismo) contra FOR (Atletismo) ou DES (Acrobacia) do alvo. Agarrado fica com deslocamento 0.",
      onclick: pick(GRAB),
    }, "🤼 Agarrar"),
    sheet.battle?.grabbing ? h("button", { class: "small", disabled: state.busy, title: "Soltar (ação livre)", onclick: () => act(() => releaseGrapple(state.item)) }, "Soltar") : null,
    grabbed ? h("button", { class: "small", disabled: state.busy, title: `Escapar de ${grabbed.byName} (ação): FOR (Atletismo) ou DES (Acrobacia) contra FOR (Atletismo)`, onclick: () => act(async () => { state.last = { ...(await escapeGrapple(rules, state.item)), kind: "note" }; }) }, "Escapar") : null,
    tracking ? h("button", {
      class: "small", disabled: state.busy || !mine || !econ.action || sheet.battle?.move?.disengage,
      title: "Desengajar (ação): seu movimento não provoca ataques de oportunidade neste turno",
      onclick: () => act(() => disengage(rules, state.item)),
    }, sheet.battle?.move?.disengage ? "🛡 Desengajado" : "🛡 Desengajar") : null);
}

// an attack of opportunity waiting for this Pokémon's owner to decide
// a Pokémon of a trainer: switch it (or it must switch: Roar, U-turn...)
function switchBlock() {
  const s = getSheet(state.item);
  if (!s?.trainer) return null;
  const must = s.battle?.mustSwitch;
  return h("div", { class: `row small ${must ? "hud-target" : ""}`, style: "gap:6px;margin:2px 0;padding:2px 6px" },
    must ? h("b", { class: "no" }, `Tem que trocar (${must.by})`) : h("span", { class: "muted" }, "Pokémon de treinador"),
    s.battle?.trapped ? h("span", { class: "chip down", title: "Não pode ser trocado voluntariamente" }, `preso: ${s.battle.trapped.move}`) : null,
    h("span", { class: "spacer" }),
    h("button", { class: `small ${must ? "primary" : ""}`, title: "Equipe do treinador: trocar, recolher", onclick: () => openTrainer(s.trainer, state.attackerId) }, must ? "Escolher quem entra" : "Trocar"));
}

function oaBlock() {
  const sheet = getSheet(state.item);
  const oa = sheet.battle?.oa;
  if (!oa) return null;
  const { rules } = state;
  const clear = () => act(() => updateSheet(state.attackerId, (s) => { delete s.battle.oa; }));
  const strike = (name) => act(async () => {
    const [target] = await OBR.scene.items.getItems([oa.targetId]);
    if (!target) throw new Error("O alvo não está mais no mapa.");
    state.last = await useMove(rules, state.item, name, [target], { opportunity: true, sentinel: oa.sentinel, ignoreRange: true, oaBack: oa.back ?? null });
    state.last._fresh = state.last.roller !== "Dice+";
  });
  return h("div", { class: "hud-target oa" },
    h("div", { class: "small" }, h("b", {}, `⚔ Ataque de oportunidade em ${oa.targetName}`), h("span", { class: "muted" }, ` · ${oa.why}`)),
    h("div", { class: "small muted" }, `Gasta a reação. ${rules.hasFeat(sheet.pkmn, "Mestre de Combate Corpo a Corpo") ? "Com vantagem (Mestre de Combate Corpo a Corpo). " : ""}${rules.hasFeat(sheet.pkmn, "Sentinela") ? "Sentinela: se acertar, ele para." : ""}`),
    h("div", { class: "row", style: "gap:4px;flex-wrap:wrap;margin-top:4px" },
      oaMoves(rules, sheet.pkmn).map((n) => h("button", { class: "small primary", disabled: state.busy, onclick: () => strike(n) }, rules.moveData(sheet.pkmn, n).label.replace(/ PMP$/, ""))),
      h("button", { class: "small", disabled: state.busy, onclick: clear }, "Ignorar")));
}

// what's waiting: a prepared action, a charge, an invulnerable phase
function waitingBlock() {
  const b = getSheet(state.item).battle ?? {};
  const rows = [];
  if (b.prepared) {
    rows.push(h("div", { class: "row small hud-wait" },
      h("span", { class: "chip cond", title: "Usado fora do turno: no início do turno ele anda até o alcance (se der) e usa sozinho" }, `⏳ Preparado: ${b.prepared.label ?? b.prepared.move}${b.prepared.targetNames?.length ? ` → ${b.prepared.targetNames.join(", ")}` : ""}`),
      h("span", { class: "spacer" }),
      h("button", { class: "small", disabled: state.busy, onclick: () => act(() => updateSheet(state.attackerId, (s) => { delete s.battle.prepared; })) }, "Cancelar")));
  }
  const c = b.charging;
  if (c) {
    const ready = releaseReady(getSheet(state.item), state.running);
    const text = c.invuln ? `🌀 ${invulnText(c)}` : c.focus ? `👊 Focando (${c.move})` : `⚡ Carregando ${c.move}`;
    rows.push(h("div", { class: "row small hud-wait" },
      h("span", { class: "chip up" }, text),
      h("span", { class: "muted" }, ready ? (c.focus ? "pronto: use já (ação livre)" : "pronto: use o Move (ação)") : "sai no próximo turno")));
  }
  if (b.prone) rows.push(h("div", { class: "row small hud-wait" }, h("span", { class: "chip down", title: "Levantar custa metade do deslocamento no próximo turno" }, "🤕 Caído")));
  return rows;
}

// "A" action, "B" bonus action, "R" reaction: what the move can spend
function timingTag(name) {
  const t = moveTiming(state.rules.moves[name] ?? {});
  const tags = [t.action || t.both ? "A" : null, t.bonus ? "B" : null, t.reaction ? "R" : null].filter(Boolean);
  return h("span", { class: "tt", title: state.rules.moves[name]?.["Move Time"] ?? "" }, tags.join("/") || "A");
}

function moveRow(m) {
  const sheet = getSheet(state.item);
  const sp = special(state.rules, m.name);
  const ch = chargingOf(sheet);
  const releasing = ch?.move === m.name;
  const twoTurns = sp && ["invuln", "focus", "charge"].includes(sp.kind);
  const activating = twoTurns && !releasing;
  const lockedOut = invulnOf(sheet) && !releasing; // invulnerable: only its own move
  const noPP = !releasing && typeof m.pp === "number" && m.pp <= 0;
  const phase = releasing ? (releaseReady(sheet, state.running) ? (sp?.kind === "invuln" ? "🌀 atacar" : "⚡ liberar") : "⏳ carregando") : twoTurns ? "2 turnos" : sp?.kind === "recharge" ? "recarga" : null;
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
    disabled: noPP || state.busy || lockedOut,
    title: `${TYPE_PT[m.type] ?? m.type} · ${[m.time, m.range].filter(Boolean).join(" · ")}${lockedOut ? " · invulnerável: só pode usar " + ch.move : ""}`,
    onclick: async () => {
      state.pending = m.name;
      state.outOfRange = null;
      if (activating) {
        // first part of Fly/Dig/Focus Punch/Solar Beam...: no targets yet
        state.mode = "self";
        state.targets = [];
        state.turnError = null;
        await roll(true);
        return;
      }
      if (m.rangeInfo.kind === "area") {
        // turn/action check first, so nobody aims for nothing
        try {
          const running = (await OBR.scene.items.getItems((i) => i.metadata?.["com.pretty-initiative/metadata"]?.active === true)).length > 0;
          chooseCost(state.item, state.rules.moves[m.name] ?? {}, running, state.rules);
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
    h("span", { class: "hud-move-name" }, timingTag(m.name), " ", m.label.replace(/ PMP$/, ""), phase ? h("span", { class: "tt phase" }, phase) : null),
    h("span", { class: "hud-move-nums" }, nums || "sem rolagem"),
    h("span", { class: `hud-move-pp ${noPP ? "no" : ""}` }, typeof m.pp === "number" ? `${m.pp}/${m.ppMax}` : "∞"));
}

// allies this player controls that can use Helping Hand on this attack (reaction, 18 m)
async function findHelpers(m) {
  state.helperCands = [];
  state.helpers = new Set();
  if (m.name === THROW || (m.attackBonus == null && !m.damage)) return;
  const items = await OBR.scene.items.getItems((i) => i.metadata?.["com.pmp-fichas/sheet"]?.pkmn?.moves?.[HELPING_HAND] && i.id !== state.attackerId);
  for (const it of items) {
    const s = getSheet(it);
    if (!(await canEdit(s)) || !allies(s, getSheet(state.item))) continue; // your own Pokémon on the same team
    const pp = state.rules.movePP(s.pkmn, HELPING_HAND);
    let reason = "";
    if (s.pkmn.hp.current <= 0) reason = "desmaiado";
    else if (typeof pp === "number" && pp <= 0) reason = "sem PP";
    else if (inInitiative(it) && !econOf(s).reaction) reason = "reação já usada";
    else if (inInitiative(it) && econOf(s).loseAction) reason = "já adiantou a ação";
    else if (invulnOf(s)) reason = "invulnerável";
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
      title: reason || "Gasta a reação deste Pokémon e a ação do próximo turno dele: +1d6 no acerto e mais dados de dano",
      onclick: reason ? null : () => { state.helpers.has(item.id) ? state.helpers.delete(item.id) : state.helpers.add(item.id); render(); },
    }, `🤝 ${item.name}${reason ? ` (${reason})` : ""}`)));
}

// "Mestre de Combate Corpo a Corpo / à Distância": optional −5 on the roll for +10 damage
function powerToggle(move) {
  if (!move?.damage || state.pending === THROW || state.pending === GRAB) return null;
  const pkmn = getSheet(state.item).pkmn;
  const feat = move.rangeInfo.kind === "melee" ? "Mestre de Combate Corpo a Corpo" : "Mestre de Combate à Distância";
  if (!state.rules.hasFeat(pkmn, feat)) return null;
  return h("label", { class: "row small", style: "gap:4px", title: feat },
    h("input", { type: "checkbox", checked: !!state.power, onchange: (e) => { state.power = e.target.checked; } }),
    move.attackBonus != null ? "−5 no acerto, +10 de dano" : "−5 na CD, +10 de dano se falhar");
}

function targetBar() {
  if (state.mode !== "target") return null;
  const move = pendingMove();
  const cancel = () => { Object.assign(state, { mode: "idle", pending: null, targets: [], ranges: new Map(), outOfRange: null, turnError: null }); render(); };
  return h("div", { class: "hud-target" },
    h("div", { class: "small" }, h("b", {}, move.label.replace(/ PMP$/, "")), ` · alcance ${move.rangeInfo.label}`),
    h("div", { class: "small muted" }, state.pending === THROW
      ? "1 alvo = arremessa um objeto. 2 tokens (Shift+clique) = a criatura arremessada (🫴) e o alvo (🎯)."
      : "Clique nos alvos no mapa (Shift+clique pra vários)."),
    h("div", { class: "targets", style: "margin:4px 0" },
      state.targets.length
        ? state.targets.map((t) => {
            const p = getSheet(t)?.pkmn;
            const r = state.ranges.get(t.id);
            const role = state.pending === THROW && state.targets.length === 2 ? (throwRoles().creature?.id === t.id ? "🫴 " : "🎯 ") : "";
            return h("span", { class: `chip on ${r && !r.ok ? "far" : ""}`, title: r?.reason ?? "" },
              role, t.name || "Token",
              p && canSeeFull(getSheet(t), state.viewer) ? ` · CA ${state.rules.ac(p)}` : "",
              r?.invuln ? " · 🌀 invulnerável" : r?.meters != null ? ` · ${fmtM(r.meters)}` : "",
              r?.jump ? ` · 🦘 pula ${fmtM(r.jump)}` : "",
              r ? (r.ok ? " ✓" : " ✗") : "");
          })
        : h("span", { class: "muted small" }, "Nenhum alvo: rola só o dano.")),
    state.pending === THROW && state.targets.length === 2
      ? h("button", { class: "small", onclick: async () => { state.throwCreature = throwRoles().target.id; await updateRanges(); render(); } }, "⇄ trocar quem é arremessado")
      : null,
    powerToggle(move),
    helpersRow(),
    state.outOfRange
      ? h("div", { class: "no small", style: "margin-bottom:4px" }, state.outOfRange.message)
      : null,
    state.turnError
      ? h("div", { class: "no small", style: "margin-bottom:4px" }, state.turnError)
      : null,
    h("div", { class: "row" },
      state.turnCode === "offturn" && state.pending !== THROW && state.pending !== GRAB
        ? h("button", { class: "primary", disabled: state.busy, title: "Fica travado neste Move: no início do turno ele anda até o alcance e usa sozinho", onclick: () => prepare() }, "⏳ Preparar")
        : null,
      state.turnError && state.isGM
        ? h("button", { class: state.turnCode === "offturn" ? "" : "primary", disabled: state.busy, onclick: () => roll(true, false, true) }, "Usar mesmo assim (mestre)")
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
  if (e.kind === "note") return h("div", { class: "hud-result small" }, e.text);
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
      if (r.attack?.sure) bits.push(h("span", { class: "ok" }, r.attack.crit ? "CRÍTICO" : "acerto garantido"), " ");
      else if (r.attack) bits.push(h("span", { class: r.attack.hit ? "ok" : "no" }, r.attack.crit ? "CRÍTICO" : r.attack.hit ? "acertou" : "errou"), ` (${r.attack.total}${r.attack.ac != null && full ? ` vs ${r.attack.ac}` : ""}) `);
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
    if (state.pending === THROW) {
      const { creature, target } = throwRoles();
      state.last = await throwAttack(state.rules, state.item, target, { ignoreRange, force, creature });
    } else if (state.pending === GRAB) {
      if (!state.targets[0]) throw new Error("Escolha no mapa quem agarrar.");
      state.last = await grapple(state.rules, state.item, state.targets[0], { ignoreRange, force });
    } else {
      state.last = await useMove(state.rules, state.item, state.pending, state.targets, { ignoreRange, area, force, helpers, power: !!state.power });
    }
    state.last._fresh = state.last.roller !== "Dice+";
    Object.assign(state, { mode: "idle", pending: null, targets: [], ranges: new Map(), outOfRange: null, turnError: null, turnCode: null, helperCands: [], helpers: new Set() });
    await OBR.player.select([state.attackerId], true); // back to the attacker
  } catch (e) {
    if (e instanceof OutOfRange) state.outOfRange = e;
    else if (e instanceof TurnError) {
      // out of its turn with a move that isn't a reaction: a player's choice is locked in (prepared);
      // the GM may prepare it or force it
      state.turnError = e.message;
      state.turnCode = e.code;
      if (e.code === "offturn" && !area && state.pending !== THROW && state.pending !== GRAB && !state.isGM) { await prepare(); return; }
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

// "Ação preparada": locked into this move; it runs by itself when the Pokémon's turn starts
async function prepare() {
  const move = pendingMove();
  const targets = state.targets.filter((t) => t.id !== state.attackerId);
  await updateSheet(state.attackerId, (s) => {
    s.battle.prepared = { move: state.pending, label: move.label.replace(/ PMP$/, ""), targetIds: targets.map((t) => t.id), targetNames: targets.map((t) => t.name) };
  });
  await pushLog({ kind: "note", attacker: state.item.name, text: `⏳ preparou ${move.label.replace(/ PMP$/, "")}${targets.length ? ` contra ${targets.map((t) => t.name).join(", ")}` : ""} (sai no início do turno dele)` });
  Object.assign(state, { mode: "idle", pending: null, targets: [], ranges: new Map(), outOfRange: null, turnError: null, turnCode: null, helperCands: [], helpers: new Set(), busy: false });
  state.item = await getItem(state.attackerId);
  render();
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

// what the moves left on this Pokémon (Leech Seed, Taunt, Substitute, Perish Song...)
function battleTags(sheet) {
  const b = sheet?.battle ?? {};
  const t = [];
  if (b.sub) t.push(`🧸 Substitute ${b.sub} HP`);
  if (b.seeded) t.push("🌱 semeado");
  if (b.cursed) t.push("👻 amaldiçoado");
  if (b.perish != null) t.push(`🎵 Perish ${b.perish}`);
  if (b.yawn != null) t.push("🥱 Yawn");
  if (b.wish) t.push("⭐ Wish");
  if (b.locked) t.push(`😤 ${b.locked.move} (${b.locked.left})`);
  if (b.stockpile) t.push(`Stockpile ${b.stockpile}`);
  if (b.charged) t.push(`⚡ ${b.charged}`);
  if (b.truantLazy) t.push("🦥 Truant: preguiça neste turno");
  if (b.disabled) t.push(`${b.disabled.move} bloqueado`);
  for (const [k, v] of Object.entries(b.restrict ?? {})) t.push(`${{ taunt: "Taunt", encore: `Encore${v.move ? ` (${v.move})` : ""}`, disable: `Disable (${v.move})`, torment: "Torment", healBlock: "Heal Block" }[k] ?? k} ${v.turns}`);
  if (b.ability) t.push(`habilidade: ${b.ability}`);
  return t;
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
      h("span", { class: "drag", title: "Arraste pra mudar a ficha rápida de lugar", onpointerdown: startDrag }, "⠿"),
      h("b", { class: "hud-name" }, state.item.name || rules.name(pkmn)),
      h("span", { class: "muted small" }, `Nv ${rules.level(pkmn)}`),
      rules.types(pkmn).map((t) => h("span", { class: "dot", style: `background:${TYPE_COLOR[t]}`, title: TYPE_PT[t] })),
      h("span", { class: "spacer" }),
      h("button", { class: "icon", title: "Mudanças de Status (estágios e pontos de dano)", onclick: () => openStages(state.attackerId) }, "📊"),
      h("button", { class: "icon", title: "Ficha completa", onclick: () => openSheet(state.attackerId) }, "☰"),
      h("button", { class: "icon", title: "Fechar", onclick: close }, "✕")),
    hpBlock(pkmn),
    rules.feats(pkmn).length ? h("div", { class: "small muted hud-feats" }, "Talentos: ",
      [...new Set(rules.feats(pkmn))].map((f, i) => h("span", { title: rules.featText?.[f] ?? "" }, `${i ? ", " : ""}${f}`))) : null,
    state.field && fieldText(state.field) ? h("div", { class: "small hud-field" }, fieldText(state.field)) : null,
    battleTags(sheet).length ? h("div", { class: "row small", style: "gap:4px;flex-wrap:wrap;margin:2px 0" }, battleTags(sheet).map((t) => h("span", { class: "chip down" }, t))) : null,
    initiativeBlock(pkmn),
    oaBlock(),
    switchBlock(),
    moveBlock(),
    actionsBlock(),
    waitingBlock(),
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
    const vh = await OBR.viewport.getHeight();
    const pos = hudPosition(vh);
    // where its top edge really is right now (in bottom mode it depends on the current height)
    const top = hudTop(window.innerHeight, vh);
    saveHudPosition({ left: pos.left + dx, top: top + dy });
    markHudAlive();
    await openHud(state.attackerId);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

// grow/shrink the popover to its content
// (never taller than the room where it sits: beyond that it scrolls instead of being cut off)
function fit() {
  requestAnimationFrame(() => {
    const needed = Math.ceil(root.getBoundingClientRect().height) + 2;
    const height = Math.min(640, needed, hudRoom());
    document.body.classList.toggle("hud-scroll", needed > height);
    saveHudHeight(Math.min(640, needed));
    OBR.popover.setHeight(HUD_ID, height).catch(() => {});
  });
}

OBR.onReady(async () => {
  syncTheme();
  state.rules = await loadRules();
  state.isGM = (await OBR.player.getRole()) === "GM";
  state.viewer = { id: OBR.player.id, role: state.isGM ? "GM" : "PLAYER" };
  await setAttacker(state.attackerId);
  state.running = await running();
  state.field = await fieldNow().catch(() => null);
  render();
  // weather / terrain / screens line (field.js)
  OBR.scene.onMetadataChange(async () => { state.field = await fieldNow().catch(() => null); render(); });
  OBR.scene.items.onChange(async (items) => {
    const it = items.find((i) => i.id === state.attackerId);
    if (it) state.item = it;
    state.running = items.some((i) => i.metadata?.["com.pretty-initiative/metadata"]?.active === true);
    state.targets = state.targets.map((t) => items.find((i) => i.id === t.id)).filter(Boolean);
    if (state.mode === "target") await updateRanges();
    render();
  });
  OBR.player.onChange((p) => { onAim(aimState(p)); onSelection(p.selection); });
});
