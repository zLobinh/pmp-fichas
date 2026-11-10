// The "defend?" popup: opens on the screen of whoever controls a Pokémon that can react to an attack
// (Protect, Wide Guard, Upper Hand, Endure...). 5 seconds to choose; time out = no defense.
// The answer goes into the Pokémon's sheet (battle.defenseAnswer), where the attacker is waiting.
import { OBR, ID, loadRules, getSheet, getItem, updateSheet, pushLog, getSettings, h, syncTheme } from "./store.js?v=0.9.12";
import { getRoller } from "./dice.js?v=0.9.12";
import { useMove } from "./combat.js?v=0.9.12";
import { approach, moveToken } from "./tactics.js?v=0.9.12";
import { DEFENSES, AFTER_HIT, streakDice, commitDefense, defenseText, roundNow } from "./protect.js?v=0.9.12";

const params = new URLSearchParams(location.search);
const pid = params.get("id");
const req = params.get("req");
const POP = `${ID}/defend/${pid}`;
const SECONDS = 5;
const root = document.getElementById("root");
let done = false, busy = false, timer = null;

const answer = (a) => updateSheet(pid, (s) => { s.battle.defenseAnswer = { req, ...a }; });
const close = () => OBR.popover.close(POP).catch(() => {});

async function decline() {
  if (done) return;
  done = true;
  clearInterval(timer);
  await answer({ status: "declined" });
  close();
}

async function choose(rules, P, ask, name) {
  if (done || busy) return;
  busy = true;
  clearInterval(timer);
  await answer({ status: "accepted", move: name });
  render(rules, P, ask, `Usando ${name}…`);
  const settings = await getSettings();
  const roller = await getRoller({ useDicePlus: settings.dicePlus, showResults: settings.dicePlusPopup });
  let ok = true, roll = "", cancel = false;
  try {
    // used in a row: 1d6 per consecutive success, all of them 5 or 6
    const { dice } = streakDice(getSheet(P), name, await roundNow());
    if (dice) {
      const [r] = await roller.batch([{ amount: dice, sides: 6, bonus: 0 }], `${P.name} ${name} (uso seguido)`);
      ok = r.dice.every((v) => v >= 5);
      roll = `${dice}d6: ${r.dice.join(", ")}`;
    }
    const isReact = DEFENSES[name]?.kind === "react" || AFTER_HIT[name];
    if (ask.kind === "switch" || isReact) {
      // Pursuit / Bolt Beak / Fishious Rend (a switch), Sucker Punch / Thunderclap / Baby-Doll Eyes /
      // Tearful Look / Withdraw (before the hit), Counter / Mirror Coat / Metal Burst / Comeuppance / Spite
      // (after it): the move itself, as a reaction that costs the next action (useMove with defense);
      // a melee one rushes next to the attacker first (no attacks of opportunity)
      const [target] = await OBR.scene.items.getItems([ask.attackerId]);
      if (!target) throw new Error("o alvo já saiu");
      const me = await getItem(pid);
      const md = rules.moveData(getSheet(me).pkmn, name);
      if (name !== "Withdraw" && md.rangeInfo?.kind === "melee") {
        const reach = rules.reach(getSheet(me).pkmn);
        const spot = await approach(rules, me, target, { rangeInfo: { kind: "melee", meters: reach, label: "corpo a corpo" } }).catch(() => null);
        if (spot) await moveToken(pid, spot.pos, 0);
      }
      const res = await useMove(rules, await getItem(pid), name, name === "Withdraw" ? [] : [target], { defense: true, ignoreRange: true, switchDouble: ask.kind === "switch" });
      const r0 = res.results.find((r) => r.targetId === ask.attackerId);
      ok = name === "Withdraw" || !!(r0?.attack?.hit || r0?.contest?.success || r0?.damage?.final);
      // Spite: 1d4 PP off the move that hit it
      if (name === "Spite" && r0?.contest?.success) {
        const lost = 1 + Math.floor(Math.random() * 4);
        await updateSheet(target.id, (s) => { const mv = s.battle.lastMove; if (mv && s.pkmn.moves[mv]) s.pkmn.moves[mv].pp = Math.max(0, rules.movePP(s.pkmn, mv) - lost); });
        await pushLog({ kind: "note", attacker: P.name, text: `Spite: ${target.name} perdeu ${lost} PP de ${getSheet(target).battle?.lastMove ?? "seu Move"}` });
      }
    } else if (name === "Upper Hand") {
      // the counterattack is a real move (reaction + next action); a hit cancels the attack
      if (ok) {
        const [attacker] = await OBR.scene.items.getItems([ask.attackerId]);
        const res = await useMove(rules, await getItem(pid), "Upper Hand", attacker ? [attacker] : [], { defense: true, ignoreRange: true });
        cancel = !!res.results.find((r) => r.targetId === ask.attackerId)?.attack?.hit;
      } else await commitDefense(rules, P, name, false, settings);
    } else {
      await commitDefense(rules, P, name, ok, settings);
    }
    if (name !== "Upper Hand" && ask.kind !== "switch" && !isReact) {
      await pushLog({ kind: "note", attacker: P.name, text: ok
        ? `usou ${name} (reação, perde a ação do próximo turno)${roll ? ` — ${roll}` : ""}: ${defenseText(name)}`
        : `tentou ${name} e falhou (${roll}); gastou a reação e a ação do próximo turno` });
    }
  } catch (err) {
    ok = false;
    roll = err.message;
  }
  done = true;
  await answer({ status: "done", move: name, ok, roll, cancel });
  close();
}

function render(rules, P, ask, status) {
  const left = Math.max(0, SECONDS - (Date.now() - started) / 1000);
  const others = ask.targets.filter((n) => n !== P.name);
  const sw = ask.kind === "switch" || ask.kind === "after";
  const who = ask.kind === "endure" ? `${ask.damage} de dano vai derrubar ${P.name}.`
    : ask.kind === "switch" ? `${P.name} pode correr até ele e atacar com o dobro dos dados.`
    : ask.kind === "after" ? `${P.name} pode revidar.`
    : others.length ? `${P.name} pode proteger ${ask.targets.join(", ")}.` : `${P.name} pode se proteger.`;
  root.replaceChildren(h("div", { class: "defend" },
    h("div", { class: "row" },
      h("b", {}, sw ? `${ask.attackerName} ${ask.move}` : `${ask.attackerName} usou ${ask.move}`),
      h("span", { class: "spacer" }),
      h("b", { class: "defend-time" }, status ? "" : `${Math.ceil(left)} s`)),
    h("div", { class: "muted small" }, `${who} Gasta a reação e a ação do próximo turno.`),
    h("div", { class: "defend-bar" }, h("i", { style: `width:${(left / SECONDS) * 100}%` })),
    status
      ? h("div", { class: "small" }, status)
      : h("div", { class: "defend-opts" },
          ask.options.map((name) => h("button", { class: "primary", title: defenseText(name), onclick: () => choose(rules, P, ask, name) },
            h("b", {}, name), h("span", { class: "small" }, ask.kind === "switch" ? "reação, dobro dos dados; perde a ação do próximo turno"
              : AFTER_HIT[name] ? { Counter: "devolve o dobro do dano corpo a corpo", "Mirror Coat": "devolve o dobro do dano à distância", "Metal Burst": "devolve 1,5× o dano", Comeuppance: "devolve 1,5× o dano", Spite: "tira 1d4 PP do Move dele" }[name]
              : defenseText(name)))),
          h("button", { onclick: decline }, sw ? "Não reagir" : "Não reagir"))));
}

let started = Date.now();
OBR.onReady(async () => {
  syncTheme();
  const rules = await loadRules();
  const P = await getItem(pid);
  const ask = getSheet(P)?.battle?.defenseAsk;
  if (!ask || ask.req !== req) return close();
  // only the options it still has (PP, reaction) when the popup opens
  ask.options = ask.options.filter((n) => DEFENSES[n]);
  started = Date.now();
  render(rules, P, ask);
  timer = setInterval(() => {
    if (busy || done) return;
    if (Date.now() - started >= SECONDS * 1000) return decline();
    render(rules, P, ask);
  }, 200);
  // the attacker gave up waiting (or someone else answered): close
  OBR.scene.items.onChange((items) => {
    const it = items.find((i) => i.id === pid);
    if (!busy && !done && getSheet(it)?.battle?.defenseAsk?.req !== req) { done = true; close(); }
  });
});
