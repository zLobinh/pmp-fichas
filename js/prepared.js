// "Ação preparada": a player picked a move out of the Pokémon's turn (and it isn't a reaction),
// so it stays locked in. When its turn starts (on the GM's browser), it runs by itself:
//   - target in range: attacks right away;
//   - out of range (melee or ranged): walks the shortest way into range, paying the movement,
//     then attacks;
//   - not enough movement: the prepared action is cancelled and the player chooses again.
import { OBR, getSheet, updateSheet, pushLog } from "./store.js?v=0.9.20";
import { fmtM } from "./rules.js?v=0.9.20";
import { checkRange } from "./map.js?v=0.9.20";
import { useMove } from "./combat.js?v=0.9.20";
import { approach, movement, moveToken, jumpOpts, checkOpportunity } from "./tactics.js?v=0.9.20";

const fresh = async (id) => (await OBR.scene.items.getItems([id]))[0];

export async function runPrepared(rules, item) {
  const p = getSheet(item)?.battle?.prepared;
  if (!p) return null;
  await updateSheet(item.id, (s) => { delete s.battle.prepared; });
  const who = item.name;
  const cancel = (why) => pushLog({ kind: "note", attacker: who, text: `⏳ ação preparada (${p.label ?? p.move}) cancelada: ${why}. Escolha outra ação.` });
  let attacker = await fresh(item.id);
  if (attacker.metadata?.["com.pmp-fichas/sheet"]?.pkmn?.hp?.current <= 0) return null;
  // no targets (Swords Dance, Fly's first part...): just use it
  if (!p.targetIds?.length) {
    await pushLog({ kind: "note", attacker: who, text: `⏳ ação preparada: usa ${p.label ?? p.move}` });
    return useMove(rules, attacker, p.move, [], {});
  }
  let targets = (await OBR.scene.items.getItems(p.targetIds)).filter((t) => (getSheet(t)?.pkmn?.hp?.current ?? 1) > 0);
  if (!targets.length) return cancel("o alvo não está mais em combate");
  const move = rules.moveData(getSheet(attacker).pkmn, p.move);
  const inRange = async () => {
    const jump = move.rangeInfo.kind === "melee" ? await jumpOpts(rules, attacker) : null;
    return checkRange(attacker, move, targets, { jump });
  };
  let res = await inRange();
  let walked = 0;
  if (res.some((r) => !r.ok)) {
    const mv = movement(rules, attacker);
    // goes towards the first target that is out of reach
    const far = targets.find((t) => !res.find((r) => r.id === t.id)?.ok);
    const spot = await approach(rules, attacker, far, move, { maxCost: mv.left });
    if (!spot) return cancel(`não tem deslocamento pra chegar ao alcance de ${far.name} (sobra ${fmtM(mv.left)}${mv.why ? `, ${mv.why}` : ""})`);
    const from = { ...attacker.position };
    await moveToken(attacker.id, spot.pos, spot.cost);
    await checkOpportunity(rules, attacker, from, spot.pos); // walking out of a reach still provokes
    walked = spot.cost;
    attacker = await fresh(item.id);
    res = await inRange();
    const out = res.filter((r) => !r.ok).map((r) => r.id);
    targets = targets.filter((t) => !out.includes(t.id));
    if (!targets.length) return cancel("nenhum alvo ficou ao alcance");
  }
  await pushLog({ kind: "note", attacker: who, text: `⏳ ação preparada: ${walked ? `andou ${fmtM(walked)} até o alcance e ` : ""}usa ${move.label.replace(/ PMP$/, "")}` });
  return useMove(rules, attacker, p.move, targets, {});
}
