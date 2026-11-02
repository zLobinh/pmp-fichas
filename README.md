# PMP Fichas — extensão do Owlbear Rodeo

Fichas do app PMP (Pokedex5E) nos tokens do Owlbear, no estilo Foundry:
importa o código que o app exporta, mostra a ficha ao clicar no token e rola os Moves contra os alvos.

## O que faz

- **Importar ficha:** clique num token → *Importar ficha do PMP* → cole o código do app.
- **Ficha rápida:** ao selecionar um Pokémon que você controla, abre no canto de baixo à esquerda um painel
  compacto com HP e os Moves. Clique num Move → clique nos alvos no mapa → *Rolar*. Depois da rolagem o
  atacante volta a ficar selecionado. Dá pra desligar a abertura automática no painel da extensão.
- **Ficha PMP:** clique num token com ficha → *Ficha PMP*.
  - HP com barra, dano/cura/HP temporário, CA, proficiência, STAB, iniciativa, atributos.
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
  de todo mundo. Sem o Dice+ (ou se ele falhar), a extensão rola sozinha e mostra os dados girando na ficha.
- **Moves de área:** "Pessoal (cone/linha/raio/semicírculo de X metros)". Ao clicar no Move, a área aparece saindo do
  Pokémon e segue o mouse, mostrando quem está dentro. Clique pra usar em todos dentro, Esc cancela.
  O dano é rolado uma vez pra área toda e cada alvo rola o próprio TR. Cone = tão largo quanto o comprimento;
  linha = 1 quadrado de largura; a distância conta a partir da borda do Pokémon.
- **Dados na tela:** o d20 e os dados de dano giram e caem no resultado (crítico dourado, 1 natural vermelho).
- **Animação no mapa:** linha do atacante até cada alvo, anel e número do dano (vermelho = acertou, dourado = crítico,
  cinza tracejado = errou). Todo mundo na sala vê.
- **Painel (ícone da pokébola):** Pokémon da cena, registro de rolagens da mesa e configurações do mestre.
- Todo mundo na sala recebe uma notificação de cada rolagem.

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
