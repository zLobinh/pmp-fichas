// Context menu entries on tokens, the quick sheet on selection, and notifications for everyone's rolls.
import { OBR, ID, SHEET_KEY, LOG_CHANNEL, asset, getSheet, canEdit } from "./store.js?v=0.9.12";
import { describe } from "./combat.js?v=0.9.12";
import { openSheet, openHud, openTrainer, autoHudEnabled, hudAlive, markHudAlive, rollNotices } from "./ui.js?v=0.9.12";
import { TRAINER, trainerOf, makeTrainer, canManage, link, rollPending } from "./trainer.js?v=0.9.12";
import { FX_CHANNEL, playFx } from "./map.js?v=0.9.12";
import { AIM_START, AIM_ABORT, startAim, abortAim, failAim } from "./area.js?v=0.9.12";
import { watchTurns, watchMarks } from "./battle.js?v=0.9.12";
import { watchMovement, TOAST } from "./tactics.js?v=0.9.12";
import { runPrepared } from "./prepared.js?v=0.9.12";
import { loadRules } from "./store.js?v=0.9.12";
import { startCombat, sendToTrainers, watchFainted } from "./qol.js?v=0.9.12";

let lastSelection = "";
let viewer = { id: null, role: "PLAYER" }; // hides enemy AC/HP from players in the notifications

// selecting one Pokémon you control opens the quick sheet (an open one follows the selection itself)
async function onSelection(selection) {
  const key = (selection ?? []).join(",");
  if (key === lastSelection) return; // player.onChange also fires for metadata changes
  lastSelection = key;
  if (!autoHudEnabled() || !selection || selection.length !== 1 || hudAlive()) return;
  const [item] = await OBR.scene.items.getItems(selection);
  const sheet = getSheet(item);
  if (!sheet || !(await canEdit(sheet))) return;
  markHudAlive(); // until the new popover starts its own heartbeat
  await openHud(item.id);
}

OBR.onReady(() => {
  OBR.contextMenu.create({
    id: `${ID}/open`,
    icons: [
      {
        icon: asset("icons/pokeball.svg"),
        label: "Ficha PMP",
        filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
      },
    ],
    onClick: (context, elementId) => openSheet(context.items[0].id, elementId),
  });

  OBR.contextMenu.create({
    id: `${ID}/quick`,
    icons: [
      {
        icon: asset("icons/area.svg"),
        label: "Ficha rápida (HP e moves)",
        filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
      },
    ],
    onClick: async (context, elementId) => {
      const item = context.items[0];
      // each player controls only their own Pokémon; anyone else's opens the (limited) sheet
      if (!(await canEdit(getSheet(item)))) return openSheet(item.id, elementId);
      markHudAlive();
      openHud(item.id);
    },
  });

  OBR.contextMenu.create({
    id: `${ID}/import`,
    icons: [
      {
        icon: asset("icons/import.svg"),
        label: "Importar ficha do PMP",
        filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined }] },
      },
    ],
    onClick: (context) =>
      OBR.modal.open({
        id: `${ID}/import`,
        url: asset(`import.html?id=${encodeURIComponent(context.items[0].id)}`),
        width: 480,
        height: 430,
      }),
  });

  // ---- trainers (trainer.js): a token that carries up to 6 Pokémon
  OBR.contextMenu.create({
    id: `${ID}/make-trainer`,
    icons: [{
      icon: asset("icons/pokeball.svg"),
      label: "Tornar treinador",
      filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined }, { key: ["metadata", TRAINER], value: undefined }] },
    }],
    onClick: async (context) => {
      const item = context.items[0];
      const gm = (await OBR.player.getRole()) === "GM";
      await makeTrainer(item, { owner: OBR.player.id, team: gm ? "inimigos" : "jogadores" });
      openTrainer(item.id);
    },
  });
  OBR.contextMenu.create({
    id: `${ID}/trainer-team`,
    icons: [{
      icon: asset("icons/pokeball.svg"),
      label: "Equipe do treinador",
      filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", TRAINER], value: undefined, operator: "!=" }] },
    }],
    onClick: async (context) => {
      if (!(await canManage(context.items[0]))) return OBR.notification.show("Só o dono deste treinador (e o mestre) vê a equipe.", "WARNING");
      openTrainer(context.items[0].id);
    },
  });
  OBR.contextMenu.create({
    id: `${ID}/trainer-absorb`,
    icons: [{
      icon: asset("icons/pokeball.svg"),
      label: "Guardar no treinador",
      filter: { min: 2, some: [{ key: ["metadata", TRAINER], value: undefined, operator: "!=" }] },
    }],
    onClick: async (context) => {
      const trainers = context.items.filter((i) => trainerOf(i));
      if (trainers.length !== 1) return OBR.notification.show("Selecione um treinador só, junto com os Pokémon.", "WARNING");
      if (!(await canManage(trainers[0]))) return OBR.notification.show("Esse treinador não é seu.", "WARNING");
      try {
        await link(await loadRules(), trainers[0], context.items.filter((i) => getSheet(i)));
        openTrainer(trainers[0].id);
      } catch (e) {
        OBR.notification.show(e.message, "ERROR");
      }
    },
  });

  // token size from the PMP size (Miúdo ½ square, Pequeno/Médio 1, Grande 2, Enorme 3, Imenso 4)
  OBR.contextMenu.create({
    id: `${ID}/fit-size`,
    icons: [{
      icon: asset("icons/area.svg"),
      label: "Ajustar tamanho (PMP)",
      filter: { every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
    }],
    onClick: async (context) => {
      const rules = await loadRules();
      // (players only resize their own Pokémon)
      const ids = context.items.filter((i) => getSheet(i) && (viewer.role === "GM" || getSheet(i).owner === viewer.id)).map((i) => i.id);
      const { fitDraft, tokenCells, cellMeters } = await import("./map.js?v=0.9.12");
      const cellM = await cellMeters();
      await OBR.scene.items.updateItems(ids, (ds) => {
        for (const d0 of ds) { const s = d0.metadata[SHEET_KEY]; fitDraft(d0, tokenCells(rules, s.pkmn, cellM), s); }
      });
      OBR.notification.show(`Tamanho ajustado: ${ids.length} token(s)`, "SUCCESS");
    },
  });
  // tokens already on the map: the right sprite (form, Mega, female) and size, without recreating them
  OBR.contextMenu.create({
    id: `${ID}/refresh-sprite`,
    icons: [{
      icon: asset("icons/pokeball.svg"),
      label: "Atualizar sprite e tamanho (PMP)",
      filter: { every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
    }],
    onClick: async (context) => {
      const items = context.items.filter((i) => getSheet(i) && (viewer.role === "GM" || getSheet(i).owner === viewer.id));
      try {
        const { refreshTokens } = await import("./trainer.js?v=0.9.12");
        const n = await refreshTokens(await loadRules(), items);
        OBR.notification.show(`Atualizado: ${n} token(s)`, "SUCCESS");
      } catch (e) { OBR.notification.show(e.message, "ERROR"); }
    },
  });
  // a new export code into a token that already has a sheet: keeps owner, team, trainer and battle
  OBR.contextMenu.create({
    id: `${ID}/reimport`,
    icons: [{
      icon: asset("icons/import.svg"),
      label: "Reimportar ficha (mantém o resto)",
      filter: { max: 1, every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
    }],
    onClick: async (context) => {
      const it = context.items[0];
      if (!(viewer.role === "GM" || getSheet(it)?.owner === viewer.id)) return OBR.notification.show("Essa ficha não é sua.", "WARNING");
      OBR.modal.open({ id: `${ID}/import`, url: asset(`import.html?id=${encodeURIComponent(it.id)}&re=1`), width: 480, height: 460 });
    },
  });

  // ---- shortcuts (qol.js) for several tokens at once
  OBR.contextMenu.create({
    id: `${ID}/start-combat`,
    icons: [{
      icon: asset("icons/area.svg"),
      label: "Iniciar combate (rola a iniciativa de todos)",
      filter: { roles: ["GM"], every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY], value: undefined, operator: "!=" }] },
    }],
    onClick: async (context) => {
      try {
        const warn = await startCombat(await loadRules(), context.items);
        if (warn) OBR.notification.show(warn, "WARNING");
      } catch (e) { OBR.notification.show(e.message, "ERROR"); }
    },
  });
  OBR.contextMenu.create({
    id: `${ID}/send-trainers`,
    icons: [{
      icon: asset("icons/pokeball.svg"),
      label: "Recolher nos treinadores",
      filter: { every: [{ key: "type", value: "IMAGE" }, { key: ["metadata", SHEET_KEY, "trainer"], value: undefined, operator: "!=" }, { key: ["metadata", SHEET_KEY, "ball"], value: undefined }] },
    }],
    onClick: async (context) => {
      try {
        const { done, skipped } = await sendToTrainers(await loadRules(), context.items);
        OBR.notification.show(`${done.length ? `Recolhidos: ${done.join(", ")}` : "Ninguém recolhido"}${skipped.length ? ` · Ficaram: ${skipped.join(", ")}` : ""}`, skipped.length ? "WARNING" : "SUCCESS");
      } catch (e) { OBR.notification.show(e.message, "ERROR"); }
    },
  });

  OBR.player.onChange((player) => onSelection(player.selection));
  OBR.broadcast.onMessage(`${ID}/hud-closed`, () => markHudAlive(false));

  OBR.broadcast.onMessage(FX_CHANNEL, ({ data }) => { playFx(data).catch(() => {}); });
  OBR.broadcast.onMessage(AIM_START, ({ data }) => {
    startAim(data).catch((e) => {
      OBR.notification.show(`Erro ao mirar a área: ${e.message}`, "ERROR");
      abortAim().catch(() => {});
      failAim(data).catch(() => {});
    });
  });
  OBR.broadcast.onMessage(AIM_ABORT, () => { abortAim().catch(() => {}); });

  // turn start/end effects and token marks run on ONE browser: the GM's
  OBR.player.getRole().then(async (role) => {
    viewer = { id: OBR.player.id, role };
    if (role !== "GM") return;
    const rules = await loadRules();
    const start = () => {
      watchTurns(rules, { onTurnStart: (item) => runPrepared(rules, item), onNewRound: () => rollPending(rules) });
      watchMarks(rules);
      watchMovement(rules);
      watchFainted(rules);
    };
    if (await OBR.scene.isReady()) start();
    else {
      const off = OBR.scene.onReadyChange((ready) => { if (ready) { off(); start(); } });
    }
  });

  // an attack of opportunity offered to one of MY Pokémon: warn and open its quick sheet
  // (the GM answers for Pokémon whose owner is not a player in the room)
  // a defense request (Protect, Wide Guard, Endure...) for one of MY Pokémon: the 5-second popup,
  // at the top of the screen (the GM answers for Pokémon whose owner is not in the room)
  // Requests already in the scene when this browser opened are old ones left behind. (Comparing
  // `at` with this computer's clock dropped requests when the two computers' clocks disagreed by a
  // few seconds: the popup never opened and the attack went on without asking.)
  const seenAsk = new Set();
  const seenOa = new Map();
  const seenChoose = new Map();
  let baseline = null;
  const takeBaseline = () => (baseline ??= (async () => {
    for (const it of await OBR.scene.items.getItems((i) => !!i.metadata?.[SHEET_KEY] || !!i.metadata?.[TRAINER])) {
      if (trainerOf(it)?.chooseIn) seenChoose.set(it.id, trainerOf(it).chooseIn.at);
      const b = getSheet(it)?.battle;
      if (b?.defenseAsk) seenAsk.add(b.defenseAsk.req + it.id);
      if (b?.oa) seenOa.set(it.id, b.oa.at);
    }
  })().catch(() => {}));
  OBR.scene.isReady().then((r) => { if (r) takeBaseline(); });
  OBR.scene.onReadyChange((r) => { baseline = null; seenAsk.clear(); seenOa.clear(); if (r) takeBaseline(); });
  let defendSlot = 0;
  OBR.scene.items.onChange(async (items) => {
    await takeBaseline();
    for (const it of items) {
      const s = getSheet(it);
      const ask = s?.battle?.defenseAsk;
      if (!ask || seenAsk.has(ask.req + it.id)) continue;
      seenAsk.add(ask.req + it.id);
      const players = await OBR.party.getPlayers().catch(() => []);
      const ownerHere = players.some((p) => p.id === s.owner);
      if (!(s.owner === viewer.id || (viewer.role === "GM" && !ownerHere))) continue;
      const width = await OBR.viewport.getWidth();
      const slot = defendSlot++ % 3; // several at once (an area): stacked
      OBR.popover.open({
        id: `${ID}/defend/${it.id}`,
        url: asset(`defend.html?id=${encodeURIComponent(it.id)}&req=${encodeURIComponent(ask.req)}`),
        width: 340,
        height: 150 + ask.options.length * 46,
        anchorReference: "POSITION",
        anchorPosition: { left: width / 2, top: 70 + slot * 40 },
        anchorOrigin: { horizontal: "CENTER", vertical: "TOP" },
        transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
        disableClickAway: true,
      }).catch(() => {});
    }
  });

  // a fainted Pokémon went back to the ball in combat: its trainer's owner picks who comes in
  OBR.scene.items.onChange(async (items) => {
    await takeBaseline();
    for (const it of items) {
      const c = trainerOf(it)?.chooseIn;
      if (!c || seenChoose.get(it.id) === c.at) continue;
      seenChoose.set(it.id, c.at);
      const players = await OBR.party.getPlayers().catch(() => []);
      const owner = trainerOf(it).owner;
      if (!(owner === viewer.id || (viewer.role === "GM" && !players.some((p) => p.id === owner)))) continue;
      OBR.notification.show(`${c.name} desmaiou e voltou pra pokébola: escolha quem entra (Liberar)`, "WARNING");
      openTrainer(it.id);
    }
  });

  OBR.scene.items.onChange(async (items) => {
    await takeBaseline();
    for (const it of items) {
      const s = getSheet(it);
      const oa = s?.battle?.oa;
      if (!oa || seenOa.get(it.id) === oa.at) continue;
      seenOa.set(it.id, oa.at);
      const players = await OBR.party.getPlayers().catch(() => []);
      const ownerHere = players.some((p) => p.id === s.owner);
      const mine = s.owner === viewer.id || (viewer.role === "GM" && !ownerHere);
      if (!mine) continue;
      OBR.notification.show(`⚔ ${it.name} pode fazer um ataque de oportunidade em ${oa.targetName}`, "WARNING");
      markHudAlive();
      openHud(it.id);
    }
  });

  // movement warnings (token sent back): for the owner and the GM
  OBR.broadcast.onMessage(TOAST, ({ data }) => {
    if (viewer.role === "GM" || data.owner === viewer.id) OBR.notification.show(data.text, "WARNING");
  });

  // every roll / damage as a notification: only for who turned it on in the panel (it floods a battle)
  OBR.broadcast.onMessage(LOG_CHANNEL, ({ data }) => {
    if (!rollNotices()) return;
    const text = describe(data, viewer);
    OBR.notification.show(text.length > 220 ? text.slice(0, 217) + "…" : text, "INFO");
  });
});
