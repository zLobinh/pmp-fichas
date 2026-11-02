# PMP Fichas — extensão do Owlbear Rodeo

Fichas do app PMP (Pokedex5E) nos tokens do Owlbear, no estilo Foundry:
importa o código que o app exporta, mostra a ficha ao clicar no token e rola os Moves contra os alvos.

## O que faz

- **Importar ficha:** clique num token → *Importar ficha do PMP* → cole o código do app.
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
- `http://localhost:8790/tools/preview-panel.html`: o painel.

## O que ainda não está nas contas

As contas seguem `pokedex/pokemon.lua`, mas estas partes do app ainda não foram portadas:

- bônus de treinador (o código exportado só traz o Pokémon);
- efeitos de item segurado e de habilidade (aparecem na ficha, mas não mexem nos números);
- Pontos de Amplificação/Redução, estágios de batalha, Mega Evolução;
- Moves de vários golpes rolam só o ataque principal (a tabela aparece na descrição).
