// Mega Evolução: ativar / desativar, como no app (pokemon.lua set_mega + megadex).
// Na ficha: pkmn.is_mega, pkmn.mega_variant ("X", "Y", "Z"...), pkmn.mega_choice ("STR", "DEX"... nas Megas
// que deixam escolher onde vai o bônus, como a Beedrill). Com ela ativa, rules.js já usa os atributos, a CA,
// o deslocamento, os tipos e a habilidade da Mega, e amp.js soma 1 Ponto de Amplificação em todo Move.
// Aqui: o token troca pro sprite da Mega, a habilidade nova entra (Drought, Intimidate...), e ao voltar pra
// pokébola ou encerrar o combate a Mega acaba.
import { OBR, getSheet, updateSheet, pushLog } from "./store.js?v=0.9.22";

export const ATTR_PT = { STR: "FOR", DEX: "DES", CON: "CON", INT: "INT", WIS: "SAB", CHA: "CAR" };

// what this Pokémon can do: null (no Mega), or { variants: ["X","Y"] | null, choice: {options, bonus} | null }
export function megaOptions(rules, pkmn) {
  const d = rules.megaOf(pkmn);
  if (!d) return null;
  const variants = d.variants ? Object.keys(d.variants) : null;
  const choice = (v) => rules.megaData(pkmn, v)?.choice ?? null;
  return { variants, choice };
}

// Zygarde: Core Enforcer <-> Nihil Light (the app swaps the move with the Mega)
function swapZygarde(pkmn, on) {
  if (pkmn.species?.current !== "Zygarde" || !pkmn.moves) return;
  const from = on ? "Core Enforcer" : "Nihil Light", to = on ? "Nihil Light" : "Core Enforcer";
  const key = Object.keys(pkmn.moves).find((k) => k.includes(from));
  if (key) { pkmn.moves[to] = { ...pkmn.moves[key] }; delete pkmn.moves[key]; }
}

export async function megaEvolve(rules, item, { variant = null, choice = null } = {}) {
  const s = getSheet(item);
  const opts = megaOptions(rules, s?.pkmn);
  if (!opts) throw new Error(`${item.name} não tem Mega Evolução.`);
  if (s.pkmn.is_mega) return null;
  const v = opts.variants ? (variant && opts.variants.includes(variant) ? variant : opts.variants[0]) : null;
  const ch = opts.choice(v);
  if (ch && !ch.options.includes(choice)) throw new Error(`Escolha onde vai o bônus da Mega: ${ch.options.map((o) => ATTR_PT[o] ?? o).join(" ou ")}.`);
  await updateSheet(item.id, (sh) => {
    sh.pkmn.is_mega = true;
    if (v) sh.pkmn.mega_variant = v; else delete sh.pkmn.mega_variant;
    if (ch) sh.pkmn.mega_choice = choice; else delete sh.pkmn.mega_choice;
    swapZygarde(sh.pkmn, true);
  });
  const fresh = (await OBR.scene.items.getItems([item.id]))[0];
  const { refreshTokens, entryAbilities } = await import("./trainer.js?v=0.9.22");
  await refreshTokens(rules, [fresh]).catch(() => {});
  const md = rules.megaData(getSheet(fresh).pkmn);
  const label = `Mega ${s.pkmn.species?.current ?? item.name}${v && !/padr/i.test(v) ? ` ${v}` : ""}`;
  await pushLog({ kind: "note", attacker: item.name, text: `✨ Mega Evoluiu: ${label}${md?.ability ? ` (${md.ability})` : ""}${ch ? ` · +${ch.bonus} ${ATTR_PT[choice] ?? choice}` : ""}` });
  // the new ability comes in like a Pokémon entering the field (Drought, Intimidate...)
  const notes = await entryAbilities(rules, (await OBR.scene.items.getItems([item.id]))[0]).catch(() => []);
  return { label, notes };
}

// back to normal (the button, the ball, the end of the fight); quiet = no log line
export async function megaRevert(rules, item, { quiet = false } = {}) {
  const s = getSheet(item);
  if (!s?.pkmn?.is_mega) return false;
  await updateSheet(item.id, (sh) => {
    sh.pkmn.is_mega = false;
    swapZygarde(sh.pkmn, false);
  });
  const { refreshTokens } = await import("./trainer.js?v=0.9.22");
  await refreshTokens(rules, [(await OBR.scene.items.getItems([item.id]))[0]]).catch(() => {});
  if (!quiet) await pushLog({ kind: "note", attacker: item.name, text: "voltou à forma normal (fim da Mega Evolução)" });
  return true;
}
