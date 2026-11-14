// Shortcuts for the table: start a combat with every selected Pokémon, send the selected ones back to
// their trainers, a long rest for a whole team, and fainted Pokémon going back to the ball by themselves.
import { OBR, SHEET_KEY, getSheet, updateSheet, pushLog, getSettings } from "./store.js?v=0.9.23";
import { PRETTY, inInitiative, teamOf, TEAMS, guardedLoop } from "./battle.js?v=0.9.23";
import { rollInitiative, distanceMeters } from "./map.js?v=0.9.23";
import { TRAINER, trainerOf, inBall, party, store, canManage } from "./trainer.js?v=0.9.23";

const running = async () => (await OBR.scene.items.getItems((i) => i.metadata?.[PRETTY]?.active === true)).length > 0;

// a clean slate for the fight: action, bonus action, reaction; movement from where it stands
function freshBattle(s, item) {
  const cond = s.battle?.cond;
  const alt = s.battle?.alt;
  const lost = s.battle?.typeLost; // Double Shock / Burn Up from an older fight
  if (lost) { if (lost.had) s.pkmn.ability_active_type = lost.had; else delete s.pkmn.ability_active_type; }
  s.battle = { ...(cond ? { cond } : {}), ...(alt ? { alt } : {}), econ: { action: true, bonus: true, reaction: true }, move: { used: 0, pos: { ...item.position } } };
}

// "Iniciar combate": every selected Pokémon (with a sheet, on the field, standing) rolls initiative;
// with no combat running, the first in the order starts round 1. Returns a short text for the GM.
export async function startCombat(rules, items) {
  const fighters = items.filter((i) => getSheet(i) && !inBall(getSheet(i)) && getSheet(i).pkmn.hp.current > 0);
  if (!fighters.length) throw new Error("Selecione os tokens dos Pokémon (com ficha) que vão lutar.");
  const already = await running();
  const rolled = [];
  for (const it of fighters) {
    if (!already) await updateSheet(it.id, (s) => freshBattle(s, it));
    const entry = await rollInitiative(rules, (await OBR.scene.items.getItems([it.id]))[0]);
    rolled.push(`${it.name} ${entry.total}`);
  }
  if (!already) {
    const order = Object.values((await OBR.scene.getMetadata())["com.pretty-initiative/order"] ?? {});
    const first = order.find((id) => fighters.some((f) => f.id === id)) ?? fighters[0].id;
    await OBR.scene.setMetadata({ "com.pretty-initiative/roundCount": 1 });
    const all = await OBR.scene.items.getItems(inInitiative);
    await OBR.scene.items.updateItems(all.map((i) => i.id), (ds) => { for (const d0 of ds) if (d0.metadata[PRETTY]) d0.metadata[PRETTY].active = d0.id === first; });
  }
  await pushLog({ kind: "note", attacker: "Combate", text: `${already ? "entraram no combate" : "começou"}: ${rolled.join(", ")}` });
  // everyone on one side: nobody is an enemy (no Protect prompt, no attack of opportunity)
  const teams = new Set(fighters.map((f) => teamOf(getSheet(f))));
  return teams.size === 1 && fighters.length > 1
    ? `Atenção: todos estão na equipe "${TEAMS[[...teams][0]]}". Pra que eles sejam inimigos (Protect, ataque de oportunidade), mude a equipe na ficha ou no painel do treinador.`
    : null;
}

// "Recolher nos treinadores": each selected Pokémon goes into its own trainer's ball
export async function sendToTrainers(rules, items) {
  const combat = await running();
  const done = [], skipped = [];
  for (const it of items) {
    const s = getSheet(it);
    if (!s || inBall(s)) continue;
    const [trainer] = s.trainer ? await OBR.scene.items.getItems([s.trainer]) : [];
    if (!trainer || !trainerOf(trainer)) { skipped.push(`${it.name} (sem treinador)`); continue; }
    if (!(await canManage(trainer))) { skipped.push(`${it.name} (treinador de outro jogador)`); continue; }
    if (combat && s.pkmn.hp.current > 0 && (await distanceMeters(trainer, it)) > 18.05) { skipped.push(`${it.name} (treinador a mais de 18 m)`); continue; }
    await store(rules, (await OBR.scene.items.getItems([it.id]))[0], trainer, { quiet: true });
    done.push(it.name);
  }
  if (done.length) await pushLog({ kind: "note", attacker: "Treinadores", text: `recolheram ${done.join(", ")}` });
  return { done, skipped };
}

// a long rest for the whole team of a trainer: full HP, PP back, conditions and stages gone
export async function longRest(rules, trainerId, { only = null } = {}) {
  if (await running()) throw new Error("Descanso longo só fora do combate (encerre o Pretty Sordid antes).");
  const list = (await party(trainerId)).filter((p) => !only || p.id === only);
  for (const p of list) {
    await updateSheet(p.id, (s) => {
      const pk = s.pkmn;
      pk.hp.current = rules.maxHP(pk);
      pk.hp.temp = 0;
      for (const n of Object.keys(pk.moves ?? {})) pk.moves[n].pp = rules.moveMaxPP(pk, n);
      pk.statuses = {};
      pk.stages = {};
      s.battle = {};
    });
  }
  return list.map((p) => p.name);
}

// ------------------------------------------------------------------ fainted -> back to the ball (GM)
// A fainted Pokémon whose trainer is within 18 m goes back by itself (the switch of a fainted one
// is free). The trainer's owner gets the panel to choose who comes in.
export function watchFainted(rules) {
  const tick = async () => {
    const settings = await getSettings();
    if (settings.autoRecall === false) return;
    // a simulated battle (prep.js) sends its reserves by itself
    const prep = (await OBR.scene.getMetadata())["com.pmp-fichas/prep"];
    if (prep?.status === "running" && prep.sim) return;
    const down = await OBR.scene.items.getItems((i) => {
      const s = i.metadata?.[SHEET_KEY];
      return s?.trainer && !s.ball && (s.pkmn?.hp?.current ?? 1) <= 0 && i.metadata?.[PRETTY]?.active !== true;
    });
    if (!down.length) return;
    const combat = await running();
    for (const it of down) {
      const s = getSheet(it);
      const [trainer] = await OBR.scene.items.getItems([s.trainer]);
      if (!trainer || !trainerOf(trainer)) continue;
      if ((await distanceMeters(trainer, it)) > 18.05) continue; // comes back once the trainer is near
      await store(rules, it, trainer, { quiet: true });
      await pushLog({ kind: "note", attacker: trainer.name, text: `${it.name} desmaiou e voltou pra pokébola${combat ? " (troca de desmaiado: ação livre; escolha quem entra no painel do treinador)" : ""}` });
      if (combat) {
        await OBR.scene.items.updateItems([trainer.id], (ds) => {
          for (const d0 of ds) d0.metadata[TRAINER] = { ...d0.metadata[TRAINER], chooseIn: { name: it.name, at: Date.now() } };
        });
      }
    }
  };
  const schedule = guardedLoop("desmaiados", tick, { delay: 1200 });
  OBR.scene.items.onChange(schedule);
  schedule();
}
