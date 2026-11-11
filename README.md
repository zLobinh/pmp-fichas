# PMP Fichas — extensão do Owlbear Rodeo

Fichas do app PMP (Pokedex5E) nos tokens do Owlbear, no estilo Foundry:
importa o código que o app exporta, mostra a ficha ao clicar no token e rola os Moves contra os alvos.

## O que faz

- **Importar ficha:** clique num token → *Importar ficha do PMP* → cole o código do app.
- **Ficha rápida:** ao selecionar um Pokémon que você controla, abre no canto de baixo à esquerda um painel
  compacto com HP e os Moves. Clique num Move → clique nos alvos no mapa → *Rolar*. Depois da rolagem o
  atacante volta a ficar selecionado. Dá pra desligar a abertura automática no painel da extensão.
- **Ficha PMP:** clique num token com ficha → *Ficha PMP*.
  - HP com barra, dano/cura/HP temporário, CA, proficiência, iniciativa, atributos (o STAB agora é ponto de
    Amplificação, já embutido nos dados dos moves).
  - Clique num atributo pra rolar o teste de resistência.
  - Tipos, natureza, habilidades, item, status (clique pra ligar/desligar).
  - **Moves:** acerto, CD, dano já calculados igual ao app, PP com − e +, descrição e tabela.
  - **Usar:** selecione os alvos no mapa (Shift+clique pra vários) e clique em *Usar*.
    - Move de ataque: d20 + acerto contra a CA do alvo. 20 natural é crítico (dobra os dados) e 1 natural erra.
    - Move de resistência: o alvo rola o TR contra a CD. Se passar, toma metade do dano.
    - Move com ataque e resistência (ex.: Acid Spray): se acertar, o alvo rola o TR pro efeito secundário.
    - Efetividade de tipo (×4, ×2, ×½, ×¼, imune), HP temporário primeiro, PP gasto.
  - **Descansar:** HP cheio, PP restaurado, status limpos.
  - **Exportar:** copia a ficha atualizada pra importar de volta no app.
- **Alcance:** o Move só rola se o alvo estiver no alcance (medido como a régua do Owlbear, borda a borda).
  "Corpo a corpo" = 1,5 m; "(9 metros)" = 9 m; "Pessoal (cone/raio/linha de X)" = alvos a até X; "Pessoal" = só ele mesmo.
  Fora do alcance aparece o aviso e o botão *Rolar mesmo assim*. O mestre pode desligar a checagem.
- **Iniciativa (Pretty Sordid):** botão 🎲 *Iniciativa* na ficha rápida e na completa (d20 + DES, +5 com Alerta).
  O valor entra direto no Pretty Sordid e a ordem é atualizada. Quando é a vez do Pokémon, a ficha rápida mostra *▶ SUA VEZ*.
  No painel, o mestre tem *Rolar iniciativa de todos*.
- **Dice+:** se o Dice+ estiver na sala, todas as rolagens (ataque, TR, dano, iniciativa) saem como dados 3D na tela
  de todo mundo. Todos os dados de um Move caem juntos num lance só (ex.: `4d20 + 4d10` pra dois alvos: ataques,
  TRs e dano) e são distribuídos entre os alvos na ordem; os bônus a extensão soma (o total que o Dice+ mostra é só
  a soma dos dados). Num crítico, só os dados extras vão num segundo lance. Sem o Dice+ (ou se ele falhar), a extensão rola sozinha e mostra os dados girando na ficha.
- **Moves de área:** "Pessoal (cone/linha/raio/semicírculo de X metros)". Ao clicar no Move, a área aparece saindo do
  Pokémon e segue o mouse, mostrando quem está dentro. Clique pra usar em todos dentro, Esc cancela.
  O dano é rolado uma vez pra área toda e cada alvo rola o próprio TR. Cone = tão largo quanto o comprimento;
  linha = 1 quadrado de largura; a distância conta a partir da borda do Pokémon.
- **Dados na tela:** o d20 e os dados de dano giram e caem no resultado (crítico dourado, 1 natural vermelho).
- **Animação no mapa:** linha do atacante até cada alvo, anel e número do dano (vermelho = acertou, dourado = crítico,
  cinza tracejado = errou). Todo mundo na sala vê.
- **Ações (Livro de Regras, pág. 47-49):** com o Pretty Sordid rodando, cada Pokémon tem Ação, Ação Bônus e Reação
  (aparecem na ficha rápida). Ação e Bônus voltam a cada rodada; a Reação volta no início do turno do próprio Pokémon.
  Fora do turno só dá pra usar Moves de reação (ex.: Quick Attack, Protect, Counter). Usar como reação um Move
  "ação / reação" (ou o Helping Hand) adianta o turno: gasta a reação **e a ação do próximo turno** (aparece
  *−Ação próx.*). Os efeitos garantidos (ex.: atordoar do Fake Out) já valem na hora. O mestre pode forçar
  ("Usar mesmo assim"). Sem ninguém ativo no Pretty Sordid, nada é cobrado (jogo livre).
- **Fake Out:** só na 1ª rodada do Pretty Sordid (como ação ou reação).
- **⏭ Passar turno:** botão na ficha rápida quando é a vez do Pokémon (passa pro próximo; depois do último, nova rodada).
  Quem aperta já processa o fim/início do turno (ações de volta, dano de condição), sem depender do mestre.
- **Controle do mestre:** o fim/início de turno (quando o turno é passado pelo Pretty Sordid), as barras de HP e o
  controle de deslocamento rodam no navegador do mestre. O painel mostra se estão ativos
  (*Controle do mestre: turnos ✓ ...*) e o último erro, se houver; erros também aparecem como notificação pro mestre.
- **Ação preparada:** se um jogador escolhe fora do turno um Move que não é reação, ele fica travado nesse Move
  (⏳ na ficha rápida, com *Cancelar*). No início do turno do Pokémon, a extensão usa sozinha: se o alvo está no
  alcance, ataca; senão, anda pelo caminho mais curto até o alcance (gastando deslocamento) e ataca. Sem
  deslocamento suficiente, cancela e avisa pro jogador escolher. Moves de área não podem ser preparados.
- **Deslocamento (pág. 50-52):** em combate, a ficha rápida mostra 👣 *usado / total*. Arrastar o token gasta os
  metros (régua do Owlbear); se passar do total ou não for o turno dele, o token volta pro lugar. Paralisado e
  Sonolento: metade; Dormindo, Congelado e Atordoado: 0; levantar de Caído custa metade. Estágio de Velocidade
  soma 1,5 m por estágio, Mobilidade +3 m. O mestre pode desligar o controle no painel.
- **💨 Disparada:** gasta a ação e dobra o deslocamento do turno.
- **Voo:** Pokémon com deslocamento de voo têm ▲/▼ (1,5 m por clique, gasta deslocamento). A altura aparece no token
  (✈ 4,5 m). A partir de 3 m ele está **Elevado**: imune a Moves de Terra (menos Thousand Arrows), e os ataques à
  distância dele contra alvos além da metade do alcance têm desvantagem (TR com vantagem). A distância conta a
  altura: maior valor (altura ou chão) + metade do menor. Se não puder mais voar (dormiu, congelou, atordoou,
  desmaiou, Smack Down), cai: 1d6 a partir de 3 m (ou do salto em altura), +1d6 a cada 3 m, e fica Caído.
- **Pulo (🦘):** num Move corpo a corpo contra um voador, um Pokémon no chão pula sozinho se der: alcança 1,5 m
  acima de si + o salto em altura (1 m + 0,5 m por ponto de FOR; metade se não andou 3 m antes). O pulo gasta
  deslocamento.
- **🤾 Arremessar (ação, pág. 53):** até 2 m + 1 m por ponto de FOR (alcança voadores). Marque 1 alvo pra jogar
  um objeto, ou 2 tokens: a criatura arremessada (🫴, ao seu alcance) e o alvo (🎯); ⇄ troca os papéis.
  Aliado ou inconsciente: sem teste, distância cheia. Inimigo: precisa estar agarrado por você, vai metade da
  distância e o agarrão termina. Contra inimigo: d20 + FOR contra a CA, 1d6 + FOR (+1d6 por categoria de tamanho
  que a criatura for maior que o alvo); Fantasmas são imunes, salvo se a criatura for Fantasma ou Sombrio.
  A criatura cai do lado do alvo, na altura dele: jogada até um voador, **fica no ar até o fim do próximo turno
  dela** (sem andar) pra bater nele corpo a corpo, depois cai (regra de Queda).
- **🤼 Agarrar (ação, pág. 54):** FOR (Atletismo) contra FOR (Atletismo) ou DES (Acrobacia) do alvo, o melhor.
  Alvo até uma categoria maior, ao alcance; Fantasma só por Fantasma/Sombrio. Agarrado = deslocamento 0.
  O agarrado usa *Escapar* (ação, teste resistido); quem agarra usa *Soltar* (livre).
- **Treinadores (até 6 Pokémon):** botão direito num token sem ficha → **Tornar treinador**. O jogador vira dono
  (equipe Jogadores); o mestre pode trocar dono e equipe no painel.
  - **Guardar:** com os Pokémon já fora da pokébola (token com ficha), selecione o treinador junto com eles →
    **Guardar no treinador**, ou no painel → *Guardar os selecionados*. O treinador "absorve" token e ficha: o token
    fica invisível debaixo dele (jogadores não veem; o mestre vê um ícone pequeno e transparente). Não apague o
    token do treinador com Pokémon guardados.
  - **Equipe do treinador** (botão direito no treinador, ou *Trocar* na ficha rápida do Pokémon): HP, condições e
    onde cada um está; *Liberar* (aparece a até 4,5 m do treinador), *Recolher* (treinador a até 18 m),
    *Trocar*, *Desvincular*. Só o dono e o mestre veem.
  - **Troca (pág. 50):** no turno do Pokémon, gastando a ação; quem entra fica no mesmo lugar e na mesma posição da
    iniciativa, com só ação bônus e reação, e rola a própria iniciativa no começo da próxima rodada. Desmaiado: troca
    livre, e o novo entra na iniciativa na rodada seguinte. Liberar um Pokémon no meio do combate também o faz entrar
    na rodada seguinte.
  - **Ao voltar pra pokébola:** estágios, concentração (cargas), proteções e prisões acabam; condições continuam.
    Natural Cure cura as condições; Regenerator recupera 1,5 × nível (mín. 3) em combate.
  - **Ao entrar:** Intimidate (inimigos a 9 m, TR de SAB ou Ataque −1; Guard Dog sobe +1), Intrepid Sword,
    Dauntless Shield, Supersweet Syrup e Hospitality são automáticos; clima/terreno (Drizzle, Electric Surge...) e
    outras (Download, Trace...) avisam no registro.
  - **Forçam troca:** Dragon Tail e Circle Throw (no acerto, sorteia quem entra), Roar (disputa) e Whirlwind (TR
    falho), em que o treinador escolhe na ficha rápida. Guard Dog e Suction Cups (e Wind Rider contra Whirlwind)
    impedem. Pokémon selvagem: aviso de fuga.
  - **Trocam o usuário (ação livre):** U-turn, Volt Switch, Flip Turn, Parting Shot, Baton Pass (passa os estágios),
    Chilly Reception, Shed Tail: a ficha rápida pede pra escolher quem entra.
  - **Prendem (sem troca voluntária):** Mean Look, Block, Spider Web, Spirit Shackle, Anchor Shot, Thousand Waves,
    Jaw Lock (os dois), Octolock, Snap Trap, Thunder Cage, Fairy Lock (até a próxima rodada), Ingrain, No Retreat;
    habilidades Shadow Tag (18 m), Arena Trap (15 m, quem está no chão) e Magnet Pull (Aço, 18 m). Fantasmas escapam
    de Mean Look, Block, Fairy Lock e das habilidades. Trocas forçadas e Moves de troca passam por cima.
- **Defesas por reação (Protect e parecidos):** quando um Pokémon de outra equipe usa um Move, antes de qualquer
  rolagem a extensão vê quem pode reagir e abre na tela do dono (ou do mestre, se o Pokémon for dele ou o dono não
  estiver na sala) um popup com **5 segundos**. Só aparece pra quem tem o Move, PP, reação livre e não está
  incapacitado nem já abriu mão da ação do próximo turno. Defender gasta a reação, a ação do próximo turno e 1 PP;
  sem resposta = não defendeu. O alvo protegido não rola acerto nem dano.
  - **Protect, Detect, Spiky Shield, Baneful Bunker, Silk Trap, Burning Bulwark:** qualquer Move de alvo único;
    **King's Shield, Obstruct:** só os danosos. Valem até o início do próximo turno do Pokémon: os ataques seguintes
    são bloqueados sem perguntar.
  - **Efeitos de contato** (atacante corpo a corpo): Spiky Shield dano igual ao nível dele, Baneful Bunker
    envenena, Burning Bulwark queima, Silk Trap −1 Velocidade, King's Shield −2 Ataque, Obstruct −2 Defesa.
  - **Wide Guard:** Moves em área ou de vários alvos (você e aliados a até 6 m). **Quick Guard:** Moves de
    Prioridade (aliados a até 9 m). **Crafty Shield:** Moves de status (aliados a até 3 m).
  - **Upper Hand:** contra um Move de Prioridade em você ou num aliado ao alcance do seu deslocamento, rola o
    contra-ataque; se acertar, o atacante fica atordoado e o ataque é cancelado.
  - **Endure:** pergunta quando o dano vai derrubar: fica com 1 HP, e continua assim até o próximo turno.
  - **Uso seguido (regra do livro):** se usou algum desses na rodada anterior, rola 1d6 por uso seguido bem-sucedido
    (máx. 6d6) e só funciona se todos derem 5 ou 6. Wide Guard e Quick Guard não perdem precisão entre si, mas
    contam pros outros. Falhando, a reação e a ação são gastas do mesmo jeito.
  - Moves de Prioridade são os que dizem "Prioridade N" no texto (Fake Out, Quick Attack, Extreme Speed...).
- **⚔ Ataque de oportunidade (pág. 54):** ao arrastar um Pokémon pra fora do alcance de um inimigo (1,5 m; 3 m
  pra Enorme ou maior), o dono do inimigo recebe um aviso e a ficha rápida dele abre com os Moves corpo a corpo
  de "1 ação" (ou Struggle) e *Ignorar*. Gasta a reação (sem perder a ação do próximo turno) e o PP normal.
  A chance some quando o turno muda. Não provoca: **🛡 Desengajar** (ação), teletransporte, ser arremessado ou
  empurrado.
- **Ataque à distância engajado (pág. 53):** inimigo a até 1,5 m e não incapacitado = desvantagem no ataque.
- **Ordem do dano (pág. 55):** Defesa/Defesa Especial do alvo antes da fraqueza/resistência. Imune ao tipo de um
  Move de dano = sem dano e sem efeito secundário.
- **Talentos com efeito automático:** Alerta, Aumento de CA, Robusto, Incansável, Mobilidade (+3 m e não provoca
  ataque de oportunidade de quem atacou corpo a corpo no turno), Corpo Apto (carência +3 rodadas), Atleta
  (levantar com 1,5 m, corrida de 1,5 m pro salto), Mestre de Combate Corpo a Corpo (vantagem no ataque de
  oportunidade, opção −5/+10), Mestre de Combate à Distância (opção −5 no acerto ou na CD / +10), Atacante
  Bestial (1x por turno rola o dano corpo a corpo 2x e fica com o maior), Sentinela (acertar o ataque de
  oportunidade puxa o inimigo de volta pro ponto onde ele saiu do alcance e deixa o deslocamento em 0; Desengajar não adianta; reação quando um inimigo a 1,5 m ataca outro),
  Investida Poderosa (depois da Disparada, ataque corpo a corpo com a ação bônus; +5 se andou 3 m), Escultor de
  Poder (Moves de área poupam 1 + MOVE aliados), Controlador de Área (área dobrada), Disputador (vantagem contra
  quem você agarra), Resiliente (TR).
- **Fly, Bounce, Dig, Dive, Phantom Force, Shadow Force:** no 1º uso o Pokémon gasta a ação, o PP e 3 m de
  deslocamento e fica **🌀 Invulnerável**: ninguém consegue mirar nele (ataques, Helping Hand, áreas), exceto os
  Moves certos: Smack Down (cancela o Fly/Bounce e derruba), Gust e Twister (dados dobrados), Thunder, Hurricane
  e Sky Uppercut contra Fly/Bounce; Earthquake e Magnitude (dados dobrados) e Fissure contra Dig; Surf e
  Whirlpool contra Dive. Enquanto isso ele só pode usar o próprio Move. No próximo turno, como ação, ataca com
  vantagem (com o −1/−2 do texto) qualquer alvo a até 12 m de onde sumiu e reaparece do lado dele. Se não
  atacar até o fim desse turno, reaparece sem atacar.
- **Focus Punch:** no 1º uso gasta a ação focando. No início do próximo turno o golpe sai como ação livre.
- **Moves de carga** (Solar Beam, Skull Bash, Razor Wind, Sky Attack, Meteor Beam...): carregam agora (com os
  estágios do texto, ex.: Skull Bash +1 Def) e são liberados com uma ação no próximo turno, sem gastar PP de novo.
  Tomar dano enquanto carrega/foca pede um TR de CON (CD 10 ou metade do dano); falhou, perdeu. Usar outro Move
  também perde a carga.
- **Moves de recarga** (Hyper Beam, Giga Impact, Blast Burn...): no próximo turno o Pokémon fica sem ação padrão
  e sem reação.
- **Condições de status (pág. 72):** Queimado, Congelado, Paralisado, Envenenado, Gravemente Envenenado, Sonolento,
  Dormindo, Atordoado, Confuso e Encantado, com imunidade por tipo, um status não-volátil por vez e Período de
  Carência. No fim do turno (no navegador do mestre): dano de Queimado/Envenenado/Gravemente Envenenado (prof. ×
  turnos seguidos), d6 pra acordar e pra descongelar, contagem da Confusão. Ao usar um Move: d4 da Paralisia, d6 da
  Confusão (com dano em si mesmo), d4 do Encanto. Desvantagem em TR conforme a condição, vantagem em ataques contra
  alvo incapacitado. Crítico acorda; dano de Fogo descongela.
- **Estágios (pág. 73):** Ataque/Ataque Especial somam prof. × estágio no dano (corpo a corpo / à distância),
  Defesa/Defesa Especial reduzem o dano recebido, Precisão soma no acerto e na CD, Evasão na CA e nos TRs,
  Velocidade na iniciativa, Margem de Crítico +3 por estágio. Crítico ignora estágios negativos do atacante e
  positivos do defensor. 20 natural no TR = sem dano; 1 natural = crítico.
- **Moves de status:** o texto do Move é lido pra aplicar sozinho estágios (Swords Dance, Growl, Charm...),
  condições por disputa (Toxic, Thunder Wave, Will-O-Wisp: "1d20 + MOVE + X contra 10 + atributo"), efeitos
  secundários ("resultado natural de 19 ou 20... fica queimado", tabelas de d6 do Dire Claw e Tri Attack,
  Metal Claw/Charge Beam no próprio usuário) e efeitos de TR falho (Nuzzle, Acid Spray). Casos especiais: Belly
  Drum, Stored Power, Power Trip, Punishment, Psych Up, Syrup Bomb, Rest, Refresh, Sparkling Aria, e Moves que
  descongelam o usuário (Burn Up, Fusion Flare). 336 dos 838 Moves têm efeito automático; os outros dependem de
  terreno, clima ou proteção (Substitute, Sunny Day...) e o mestre aplica na ficha completa.
- **Helping Hand:** ao escolher os alvos de um ataque, aparecem seus Pokémon com Helping Hand, reação livre e a até
  18 m. Marcando, eles gastam a reação, a ação do próximo turno deles e 1 PP. Dado no acerto: d6 (d8 no nível 5,
  d10 no 10, d12 no 17), um só por vez. Dano: cada ajudante soma metade dos dados originais do Move (1 dado: rola
  2x e fica com o maior).
- **Equipes e donos:** cada ficha tem uma equipe (Jogadores, Inimigos ou Neutros) e um dono. Jogador que importa
  vira dono e entra em Jogadores; o mestre escolhe a equipe na importação e pode trocar equipe e dono na ficha
  completa. Cada jogador só usa os próprios Pokémon (ficha rápida e Moves).
- **O que os jogadores veem:** a ficha completa só dos **próprios** Pokémon. Dos outros (inimigos e Pokémon de
  outros treinadores), só nome, tipo, barra de HP (sem números), condições e buffs/debuffs. A CA e o HP somem do
  registro, das notificações e da lista de alvos. O mestre vê tudo.
- **Token:** barra de HP embaixo de todo Pokémon com ficha, etiqueta com condições e estágios (▲ Atq +2, ▼ Def −1),
  cinza quando desmaia. Pokémon desmaiado sai da iniciativa do Pretty Sordid (se era a vez dele, passa pro próximo).
- **Mudanças de Status (📊):** popup igual ao do app, com os 8 estágios (−6 a +6) e o efeito de cada um, mais os
  Pontos de Amplificação e Redução de Dano (passos de 0,5, regras da pág. 57-58) em duas partes: **dano que ele
  causa** (o do app) e **dano que ele recebe** (ex.: Reflect = Redução no dano recebido). No golpe, os pontos de quem
  ataca e os de quem recebe se somam; primeiro a Amplificação, depois a Redução. Tudo entra nas contas.
- **Amplificação igual ao app 1.98 / livro novo (amp.js):** tudo vira ponto e se soma antes de virar efeito
  (0,5 = +½ prof.; ponto ímpar = rola 2x e fica com o maior; cada 2 = +1 dado a cada 2 dados):
  - **STAB** não soma mais dano fixo: é 1 ponto (Adaptability troca pelos 2 dela);
  - **itens** (app `items.amplification`): de tipo (Charcoal, Mystic Water...) 1, orbes de lendário 1, Choice
    Band/Specs 2, Muscle Band/Wise Glasses 0,5, gemas 1 (com o ATIVAR do app), **Life Orb** 1 ponto com a regra
    dela (+1 dado a cada 3; sobrou dado, rerrola), Deep Sea Tooth dados ×2; Light Ball, Thick Club e Punching Glove
    somam dano fixo; Wide Lens +1 acerto/CD; Razor Claw/Scope Lens +3 crítico; Bright Powder +1 CA/resistência;
  - **habilidades** (app `abilitydex.amplification`): Tough Claws, Iron Fist, Strong Jaw, Technician, Sharpness,
    Blaze/Overgrow/Torrent/Swarm, Guts, -ate, Reckless... com os pontos do app; Defeatist e Slow Start viram Redução;
    as que dependem do campo (Solar Power, Sand Force, Flash Fire, Protosynthesis, Plus/Minus, Analytic, Sheer
    Force...) ligam sozinhas pelo campo/aliados, e o ATIVAR do app também vale;
  - **clima e terreno:** sol/chuva +2 pontos no tipo deles e dados pela metade no oposto, terrenos 1 ponto,
    Misty (Dragão), Grassy (Earthquake...) e areia/granizo (Solar Beam) como Redução;
  - "dobra / metade dos dados" (Water Bubble, Charge, Facade...) multiplica os dados **depois** dos pontos;
  - num Move "2x", os pontos só mudam o primeiro golpe (a Redução vale pra todos);
  - a ficha mostra os dados já amplificados como o app (ex.: Ember com Charcoal "3d8+2"; só STAB "2d8+2 (rola 2x,
    maior)"), e o registro do golpe lista as fontes e o total de pontos.
  Os dados (moves, espécies, regras) foram reconstruídos do app novo (`tools/build_data.py`).
- **Helping Hand como Move:** usado num aliado, o dado já rola na hora e fica esperando nele: vale pro próximo
  ataque (ou TR) dele, junto com os dados de dano extras (ou até o fim da rodada).
- **Estágios importados do app:** o app exporta estágios vazios como lista (`"stages": []`); a extensão converte
  pra que os estágios ganhos em combate (Power-Up Punch, Swords Dance...) fiquem salvos.
- **Ficha rápida arrastável:** segure o ⠿ no título, arraste e solte; ela reabre ali e lembra o lugar.
- **Painel (ícone da pokébola):** Pokémon da cena, registro de rolagens da mesa e configurações do mestre,
  incluindo *Encerrar combate* (zera estágios e ações, tira condições voláteis, Gravemente Envenenado vira Envenenado).
- Todo mundo na sala recebe uma notificação de cada rolagem.
- **Atalhos com vários tokens selecionados (botão direito):** *Iniciar combate* (mestre) rola a iniciativa de
  todos e, sem combate rodando, começa a rodada 1 com o primeiro da ordem (avisa se estão todos na mesma equipe);
  *Recolher nos treinadores* guarda cada Pokémon na pokébola do próprio treinador.
- **Desmaiado volta pra pokébola sozinho** quando o treinador está a até 18 m (opção nas configurações). Em
  combate, o painel do treinador abre pro dono escolher quem entra.
- **Trainer Card:** o painel do treinador virou um cartão com os 6 Pokémon em molduras, a arte do token do
  treinador, 8 insígnias (o mestre clica pra marcar) e o botão *Descanso longo* (equipe toda, fora do combate).
- **Áreas no mapa (field.js):** Rain Dance, Sunny Day, Sandstorm, Hail, Snowscape (15 m, seguem quem usou),
  os terrenos (12 m, fixos), Reflect, Light Screen, Aurora Veil, Safeguard, Mist (fixos, da equipe de quem usou),
  Tailwind (15 m, segue), Spikes, Toxic Spikes, Stealth Rock e Sticky Web (6 m, no alvo; dá pra arrastar) e os
  redemoinhos de Whirlpool, Fire Spin, Sand Tomb, Infestation e Magma Storm (1,5 m, embaixo do alvo) viram
  círculos no mapa. Os efeitos valem só pra quem está dentro. As áreas com duração entram no Pretty Sordid logo
  depois de quem usou, com as rodadas que faltam no nome ("☀️ Sunny Day (4)"); no turno delas a contagem
  desce e no fim elas somem. Entrar em Spikes/Stealth Rock/Toxic Spikes/Sticky Web (andando ou saindo da
  pokébola ali) aplica o efeito; entrar ou sair de um redemoinho machuca (1x por turno) e terminar o turno
  dentro também. Na troca, o clima/Tailwind que seguia quem saiu passa a seguir quem entrou.
- **Preparar batalha (prep.js):** selecione dois ou mais treinadores → botão direito → "Preparar batalha"
  (o mestre). No popup o mestre escolhe os lados, o formato (1v1, 2v2, 3v3: Pokémon em campo por lado,
  divididos entre os treinadores do lado, no máximo um ativo por treinador quando há vários), as reservas de
  cada treinador e a arena (dois cliques no mapa; os iniciais aparecem dentro dela). Depois de "Regras
  prontas", cada lado escolhe os iniciais no próprio popup sem ver os do outro (só "escolhendo"/"pronto").
  Com todos prontos, a batalha começa sozinha e limpa: o que sobrou de outra luta sai da iniciativa, rodada 1,
  iniciais em campo. O popup volta pelo card "⚔ Batalha preparada → Abrir" no painel (ou pelo mesmo botão
  direito), e o resultado abre sozinho quando a luta acaba. "Encerrar e limpar" (mestre, durante ou depois)
  tira os lutadores da iniciativa e apaga a arena e as áreas de clima/terreno.
- **Simular (só treinadores do mestre):** a extensão joga os turnos. Cada Pokémon dá nota a todos os seus
  Moves e usa o melhor que funcionar: dano num inimigo (chance de acerto contra a CA, tipo, golpes, chance de
  derrubar, condição extra), dano em área (cone, linha, raio a partir dele, descontando aliados pegos),
  condições num inimigo sem status e não imune (Thunder Wave, Will-O-Wisp, Sleep Powder...), estágios dele
  (Swords Dance...) enquanto está saudável, estágios pra baixo no inimigo, cura com pouca vida (ele ou um
  aliado), clima/terreno que ajudam o tipo dele, telas e Tailwind, hazards se o outro lado tem reservas.
  Move sem dano não se repete pelo mesmo Pokémon em 4 rodadas, e há um pouco de sorte na escolha. Ela só
  joga depois que o início do turno foi processado; se um turno travar por 15 s, ela passa. Quando nenhum
  Move dá certo, o registro diz o porquê. Quem desmaia volta e a próxima reserva entra. No fim sai o resumo
  (vencedor, rodadas, nocautes, quem mais causou dano e quem ficou de pé). Ninguém reage pelos popups.
- **Início de 2v2 / 3v3:** a batalha fica "começando" enquanto os iniciais saem e rolam iniciativa; a
  simulação só joga depois (antes ela mandava "reservas" no meio do início e marcava gente como "entrou
  agora"). Cada treinador põe em campo o que o formato manda: se faltar inicial escolhido (ou um não puder
  sair), o próximo de pé entra no lugar, e o registro diz quem cada um mandou. O formato, as reservas e a
  simulação da última batalha voltam na próxima. Se uma mudança no popup não salvar, ele avisa.
- **IA em grupo:** cada inimigo tem um peso pelo dano que ele faz no nosso lado (os perigosos primeiro) e pela
  vida que falta (terminar quem está machucado); o time foca no alvo que um aliado atacou na rodada (dois golpes
  num só valem mais que um em cada); condições vão no inimigo mais perigoso; área nunca derruba aliado; clima e
  terreno só quando ajudam mais o nosso lado que o deles; telas/Tailwind valem mais com mais aliados dentro;
  sem alcance, anda até o alvo do time.
- **Marcador da área na iniciativa:** um selo redondo pequeno na borda do círculo (não em cima de quem usou o
  Move); o ícone antigo, sem tamanho próprio, virava uma tarja preta no Owlbear.
- **Entrou nesta rodada:** só pula a vez na rodada exata em que entrou; um registro velho de outra luta é
  descartado (era o que travava o Absol pulando a vez sem parar).
- **Equipe Selvagens:** pra Pokémon que não são de treinador (como Neutros).
- **Áreas na iniciativa:** o Pretty Sordid só lista tokens, então cada área com duração ganha um marcador
  (uma imagem pequena presa ao círculo) que entra na iniciativa no lugar dela, com as rodadas no nome.
- **Dano de campo visível:** dano e cura do começo/fim do turno (areia, granizo, veneno, queimadura,
  redemoinho, Leech Seed, Grassy Terrain) e dos perigos no chão aparecem flutuando no token, como o de ataque.
- **Quem entra no meio do combate** (liberado, ou no lugar de um desmaiado) rola a iniciativa na hora e já
  aparece no Pretty Sordid; o turno dele na rodada em que entrou é pulado sozinho, e ele age a partir da próxima.
- **Moves só de reação** (Sucker Punch, Thunderclap, Counter, Mirror Coat, Metal Burst, Comeuppance, Spite,
  Protect e a família) não podem ser usados como Move normal pela ficha: só pelo popup, quando o gatilho
  acontece (o mestre ainda pode forçar).
- **Dados coloridos no Dice+:** acerto, dano e golpes extras pedem dados com nomes da bolsa do Dice+ (padrão
  "Acerto", "Dano" e "Extra", trocáveis no painel). Crie esses três na bolsa do Dice+ com as cores (azul claro,
  vermelho, laranja); sem eles, o Dice+ usa os dados normais.
- **Moves que prendem:** Wrap, Bind, Clamp, Snap Trap, Thunder Cage e Octolock deixam o alvo agarrado e
  machucam no fim de cada turno dele (Octolock também tira Defesa e Defesa Especial).
- **Reações com gatilho (popup como o Protect):** antes do golpe, Sucker Punch e Thunderclap atacam primeiro
  (o Sucker Punch corre até o atacante se estiver no deslocamento), Baby-Doll Eyes e Tearful Look baixam o
  Ataque, Withdraw sobe a Defesa e Magic Coat devolve Moves de status; se o atacante desmaiar, o golpe não sai.
  Depois do golpe, Counter, Mirror Coat, Metal Burst e Comeuppance devolvem o dano e Spite tira 1d4 PP.
- **Descrição do move:** parando o mouse em cima de um move na ficha rápida aparece o texto inteiro.
- **Atualizar tokens que já existem:** botão direito → "Atualizar sprite e tamanho (PMP)" (ou "Atualizar
  sprites" no cartão do treinador, pra equipe toda) troca a imagem pela certa e ajusta o tamanho sem recriar
  nada; "Reimportar ficha (mantém o resto)" cola um código novo mantendo dono, equipe, treinador e batalha.
- **Reações à troca:** quando um Pokémon é trocado, a troca espera os inimigos que podem reagir (o mesmo
  popup de 5 s do Protect): **Pursuit** ataca quem está saindo, **Bolt Beak** e **Fishious Rend** quem acabou
  de entrar. O atacante corre até o alvo sem provocar ataque de oportunidade, rola com o dobro dos dados, gasta
  a reação e perde a ação do próximo turno.
- **Illusion (Zoroark):** no cartão do treinador, escolha por quem ele se passa (outro Pokémon da equipe). Ao
  sair da pokébola, o token fica com a imagem, o tamanho, o nome e os tipos (na ficha dos outros) do disfarce;
  o primeiro dano desfaz a ilusão (e voltar pra pokébola também).
- **Adicionar pelo código:** no cartão do treinador, "Adicionar Pokémon pelo código do app" cria o token com o
  sprite da extensão Imagem por Link (mesma lista), o tamanho certo e a ficha, já na pokébola (invisível e
  travado desde o começo, os jogadores não veem). O sprite segue a ficha: forma (Hisui usa o GIF "Nome2",
  Alola/Galar/outras usam a arte do app), Mega/Primal (X/Y/Z pela arte do app, as outras pelo GIF) e fêmea.
  As formas que a coleção de GIFs não tem entram no repositório `mapas` pelo
  `imagem-link/tools/montar_formas.py` (arquivos `forma_...`, que o `montar_pokemon.py` não apaga).
- **Tamanho do token pelo PMP:** Miúdo ½ quadrado, Pequeno/Médio 1, Grande 2, Enorme 3, Imenso 4. Na
  importação (opção marcada por padrão), na criação pelo código e no menu "Ajustar tamanho (PMP)".
- **Sem spam de avisos:** rolagens e danos não aparecem mais como notificação na tela (ficam no registro do
  painel). Quem quiser pode religar em "Minhas preferências".
- **Habilidades automáticas (abilities.js):** as 287 habilidades dos Pokémon do PMP entram nas contas quando
  dá: acerto/CD (Compound Eyes, Hustle, Victory Star), crítico (Super Luck, Merciless, Sniper, Battle Armor),
  dados de dano (Blaze/Torrent/Overgrow/Swarm, Guts, Technician, Adaptability, Iron Fist, Strong Jaw, Sharpness,
  Sheer Force, Tough Claws, auras, Ruin...), tipo (Normalize, Pixilate, Refrigerate, Liquid Voice, Scrappy, Tinted
  Lens), imunidades e absorção (Levitate, Volt/Water Absorb, Flash Fire, Sap Sipper, Lightning Rod, Storm Drain,
  Bulletproof, Soundproof, Wonder Guard, Telepathy, Good as Gold, Magic Bounce), cortes de dano (Thick Fat,
  Fluffy, Fur Coat, Filter/Solid Rock, Multiscale, Sturdy, Disguise, Ice Face, Friend Guard, Marvel Scale),
  contato (Static, Flame Body, Poison Point, Effect Spore, Rough Skin, Iron Barbs, Gooey, Mummy, Cute Charm,
  Poison Touch), ao ser atingido (Stamina, Justified, Rattled, Weak Armor, Anger Point, Berserk, Emergency Exit),
  ao derrubar (Moxie, Chilling/Grim Neigh, Aftermath, Innards Out), condições (Limber, Insomnia, Immunity, Own
  Tempo, Synchronize, Shield Dust...), estágios (Clear Body, Hyper Cutter, Big Pecks, Contrary, Simple, Defiant,
  Competitive, Mirror Armor), fim do turno (Speed Boost, Shed Skin, Poison Heal, Magic Guard, Rain Dish, Dry Skin,
  Healer, Bad Dreams, Truant, Slow Start), entrada (Drizzle e cia., terrenos, Intimidate, Download, Moody, Trace,
  Costar, Screen Cleaner, Supreme Overlord, Anticipation, Forewarn, Frisk), iniciativa e deslocamento (Swift Swim,
  Chlorophyll, Sand Rush, Slush Rush, Quick Feet, Stall, Unburden), ação bônus (Prankster, Gale Wings, Triage),
  Pressure, Damp, Dazzling/Queenly Majesty, Armor Tail, Unseen Fist, Long Reach, Run Away, Neutralizing Gas,
  Mold Breaker. As que só mudam forma ou revelam algo (Illusion, Imposter, Zen Mode...) aparecem como aviso.
- **Clima, terreno e campo (field.js):** Rain Dance, Sunny Day, Sandstorm, Hail, Snowscape e os terrenos ficam
  na cena por 5 rodadas e aparecem na ficha rápida. Chuva/sol mudam os dados de Água/Fogo, Thunder/Hurricane
  acertam na chuva, Blizzard no granizo, Solar Beam sai na hora no sol, areia/granizo machucam no começo do
  turno, Grassy Terrain cura, Electric Terrain acorda, Misty Terrain bloqueia condições, Psychic Terrain tira a
  ação bônus. Safeguard, Mist e Tailwind valem pros aliados no raio; Trick Room fica registrado.
- **Reflect, Light Screen e Aurora Veil (livro novo):** ao usar, a ficha rápida pergunta **"Só em mim"** (o escudo
  fica em volta de quem usou e corta o dano pela metade, só pra ele) ou **"Ampliar p/ aliados"** (cobre os
  aliados no raio de 4,5 m / 6 m, mas o corte cai pra 1/3). O escudo fica fixo onde foi criado (quem sai dele
  perde a proteção), não vale contra crítico e Aurora não se soma com Reflect/Light Screen: vale o melhor.
  Na simulação, a IA amplia quando tem aliado dentro do raio.
- **Moves especiais (movefx.js):** cura (Recover, Roost, Moonlight pela tabela do clima, Rest, Wish, Heal
  Pulse, Swallow), dreno (Giga Drain, Drain Punch...), recuo (Double-Edge, Brave Bird...), erro que machuca
  (Jump Kick, Supercell Slam), golpes variáveis (Fury Attack, Bullet Seed, Rock Blast: d8 de golpes extras, Skill
  Link = 4), dano fixo (Seismic Toss, Night Shade, Dragon Rage, Super Fang, Counter, Mirror Coat, Metal Burst,
  Endeavor, Final Gambit, Pain Split), dados dobrados por condição (Hex, Venoshock, Brine, Facade, Acrobatics,
  Payback, Revenge, Assurance, Smelling Salts, Wake-Up Slap, Lash Out, Bolt Beak, Fusion Bolt/Flare, Minimize,
  Weather Ball, Terrain Pulse, Rising Voltage...), tamanho (Heavy Slam, Low Kick), vida (Eruption, Reversal),
  iniciativa (Gyro Ball, Electro Ball), Stockpile/Spit Up, Fury Cutter, Return/Frustration, Hidden Power, Body
  Press, Foul Play, Psyshock, False Swipe, Knock Off, Leech Seed, Curse, Perish Song, Yawn, Taunt, Encore,
  Disable, Torment, Heal Block, Outrage/Thrash (frenesi + confusão), Substitute, Charge, Haze, Clear Smog,
  Aromatherapy, Heal Bell, Explosion, Memento, Healing Wish. Spikes/Stealth Rock/Toxic Spikes/Sticky Web
  avisam pra marcar a área no mapa.
- **Moves de vários golpes** ("Faça dois/três ataques": Double Kick, Dual Wingbeat, Triple Dive...): uma rolagem
  de ataque por golpe, bônus de MOVE só no 1º, Triple Axel com 1x/2x/3x os dados. Com mais de um alvo
  selecionado, os golpes se revezam entre eles.
- **Acerto garantido** (Swift, Aerial Ace...): rola o d20 só pra ver o crítico; acerta sempre, até no 1 natural.
- **Moves "1 ação / reação"** (Quick Attack, Vacuum Wave, Pursuit): a reação só vale fora do próprio turno; no
  turno, sem a ação, o Move não sai (antes gastava a reação e tirava o ataque de oportunidade). Quando alguém sai
  do alcance e não há ataque de oportunidade, o registro diz o motivo (reação gasta, Desengajar, Mobilidade).
- **Talentos e habilidades** na ficha completa (clique pra ver a descrição) e os talentos na ficha rápida.
- **Equipes:** passar um Pokémon ou treinador pra um jogador já coloca na equipe Jogadores. Protect e ataque de
  oportunidade só valem entre equipes diferentes (o Protect também vale contra Move de dano de aliado).

A ficha fica guardada no próprio token, então todo mundo vê a mesma coisa. Os jogadores só editam as fichas que eles importaram; o mestre edita todas.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub chamado `pmp-fichas` e envie **o conteúdo desta pasta** pra raiz dele.
   Os caminhos do `manifest.json` começam com `/pmp-fichas/` porque o Owlbear monta o endereço a partir do domínio.
   Se o repositório tiver outro nome, troque `/pmp-fichas/` pelo nome dele nas 4 linhas do manifest.
2. No repositório: *Settings → Pages → Build and deployment → Source: Deploy from a branch*, branch `main`, pasta `/ (root)`. Salve.
3. Espere 1–2 minutos. O link fica `https://SEU-USUARIO.github.io/pmp-fichas/`.
4. No Owlbear: perfil → *Extensions* → **+** → `https://SEU-USUARIO.github.io/pmp-fichas/manifest.json`.
5. Dentro da sala, ative a extensão *PMP Fichas*.

Cada jogador não precisa instalar nada: a extensão ativada na sala funciona pra todos.

## Publicar uma versão nova

O GitHub Pages deixa o navegador guardar os arquivos por 10 minutos. Antes de subir mudanças no código,
troque a versão (isso marca todos os scripts com `?v=`, e o navegador baixa os novos):

```bash
python tools/bump_version.py 0.2.1
```

## Atualizar os dados do PMP

Os dados (moves, Pokémon, níveis, naturezas) ficam em `data/`. Quando mudar algo no app, gere de novo e suba:

```bash
python tools/build_data.py "C:/caminho/para/Pokedex5E-master"
```

## Testar sem o Owlbear

Sirva esta pasta e abra no navegador:

```bash
python -m http.server 8790
```

- `http://localhost:8790/tools/test-rules.html`: confere as contas com os casos de teste do app.
- `http://localhost:8790/tools/preview-sheet.html?id=a`: a ficha com um Owlbear de mentira (Bulbasaur atacando um Charmander).
- `http://localhost:8790/tools/preview-hud.html?id=a`: a ficha rápida.
- `http://localhost:8790/tools/preview-panel.html`: o painel.

## O que ainda não está nas contas

As contas seguem `pokedex/pokemon.lua`, mas estas partes do app ainda não foram portadas:

- bônus de treinador (o código exportado só traz o Pokémon);
- efeitos de item segurado e de habilidade (aparecem na ficha, mas não mexem nos números);
- Pontos de Amplificação/Redução, estágios de batalha, Mega Evolução;
- Moves de vários golpes rolam só o ataque principal (a tabela aparece na descrição).
- deslocamento de nado/escalada/escavação (aparecem na ficha rápida, mas o controle usa andar e voo), terreno
  difícil, ataques de oportunidade e "Ataques à distância engajados";
- Sky Drop, Bide, Shell Trap e Beak Blast não têm fase automática (use pela descrição).

Alguns Moves do app (Acid Spray, Horn Attack, Low Sweep, Octolock e mais 8) descrevem um teste de resistência mas
estão sem o campo "Save" no JSON; a extensão lê o atributo do texto ("teste de CON contra sua CD de Move").
