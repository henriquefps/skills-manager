# skm: skills manager

Gerencie as skills dos seus agentes (pastas com um `SKILL.md`) em um só lugar, pelo
terminal ou por uma interface web local. O `skm` enxerga ao mesmo tempo as skills
**globais** (da sua home) e as **locais** (do projeto em que você está).

- Sem dependências, sem build. Só Node.js 20 ou mais novo.
- Roda só em `127.0.0.1`; nada sai da sua máquina.
- Nunca apaga de verdade: apagar move para uma pasta de lixeira.

## Instalação

```sh
git clone <url-do-repo> ~/orca/projects/skills-manager
cd ~/orca/projects/skills-manager
node -v   # precisa ser >= 20
```

Escolha uma das formas de ter o comando `skm` no terminal:

**Alias no `~/.zshrc`** (sem instalar nada globalmente):

```sh
alias skm='node "$HOME/orca/projects/skills-manager/bin/skm.mjs"'
```

Depois rode `source ~/.zshrc`.

**Ou `npm link`** (cria o comando `skm` no seu PATH):

```sh
npm link
```

Para conferir: `skm --help`.

## Como as skills são organizadas

O `skm` assume esta convenção, e o comando `normalize` leva suas skills até ela.

| O quê | Onde |
| --- | --- |
| Repositório central global | `~/.agents/skills/<nome>/` (pasta real) |
| Visão do Claude (global) | `~/.claude/skills/<nome>` (symlink para a pasta central) |
| Globais inativas | `~/.agents/skills-inactive/<nome>/` |
| Lixeira global | `~/.agents/skills-trash/<nome>-<timestamp>/` |
| Skills locais | `<projeto>/.claude/skills` e/ou `<projeto>/.agents/skills` |
| Locais inativas | `skills-inactive` ao lado de onde a skill estava |

A raiz do projeto é o ancestral mais próximo do diretório atual que tenha `.git`,
`.agents` ou `.claude`.

## Uso rápido

```sh
cd meu-projeto
skm            # abre a interface web (porta 4747) para global + local
skm list       # tabela no terminal
skm doctor     # lista problemas e o comando que resolve cada um
```

## A interface web

Rodar `skm` sem argumentos sobe o servidor e abre o navegador. Lá você pode:

- alternar entre **Global** e **Local**, buscar e filtrar por status;
- **ativar/inativar** com o toggle de cada skill;
- **Promover** uma skill local para global, ou **Copiar para local** uma global;
- **Normalizar** uma skill com problema (para `diverged`, escolher qual lado manter);
- **Apagar** (vai para a lixeira), com confirmação;
- abrir **Details** para ver o `SKILL.md` e a árvore de arquivos;
- usar **Fix all** no banner de problemas, com pré-visualização do que vai mudar.

Opções: `--port <n>` para escolher a porta (se estiver ocupada, usa a próxima livre)
e `--no-open` para não abrir o navegador.

## Comandos

```
skm                       abre a UI do diretório atual
skm list [--json]         skills globais e locais com status
skm doctor                problemas encontrados e a correção sugerida
skm normalize [nome|--all] [--keep agents|claude] [--dry-run]
skm activate <nome>       [--local|--global]
skm deactivate <nome>     [--local|--global]
skm promote <nome>        local -> global (cópia)   [--overwrite]
skm pull <nome>           global -> local (cópia)   [--overwrite] [--target agents|claude]
skm delete <nome>         [--local|--global]
```

Opções gerais: `--yes` (pula a confirmação), `--dry-run` (só mostra o que faria),
`--json`, `--port <n>`, `--no-open`.

Se o mesmo nome existe em global e local, informe `--local` ou `--global`.

## Receitas

**Arrumar a bagunça de duplicatas entre `.agents` e `.claude`**

```sh
skm doctor
skm normalize --all --dry-run   # veja o que vai mudar
skm normalize --all
```

Isso adota skills que só existem no `.claude` para o `.agents`, troca cópias idênticas
por symlink e cria os symlinks que faltam. Skills `diverged` (conteúdo diferente nos
dois lados) nunca são resolvidas sozinhas:

```sh
skm normalize log-session --keep agents   # ou --keep claude
```

**Desligar uma skill sem apagar**

```sh
skm deactivate wrangler
skm activate wrangler     # para voltar
```

**Transformar uma skill do projeto em global**

```sh
cd meu-projeto
skm promote minha-skill
```

**Usar uma skill global só neste projeto**

```sh
skm pull minha-skill                  # copia para .claude/skills do projeto
skm pull minha-skill --target agents  # ou para .agents/skills
```

## Status das skills

| Status | Significado | Correção |
| --- | --- | --- |
| `ok` | Tudo certo | |
| `needs-link` | Existe em `.agents`, falta o symlink no `.claude` | `normalize` |
| `duplicate` | Pasta real nos dois lados, idênticas | `normalize` |
| `diverged` | Pasta real nos dois lados, conteúdo diferente | `normalize --keep agents\|claude` |
| `claude-only` | Só existe no `.claude` | `normalize` (adota no `.agents`) |
| `broken-link` | Symlink aponta para algo que não existe | revisar manualmente |
| `wrong-link` | Symlink do `.claude` aponta para outro lugar | `normalize` |
| `empty` | Pasta sem `SKILL.md` | revisar ou apagar |
| `conflict` | Há arquivos `*.sync-conflict-*` do Syncthing | resolver manualmente |

Pastas ocultas como `.trash`, `.stfolder` e `synced` são ignoradas.

## Desenvolvimento

```sh
npm test    # node:test, sempre em pastas temporárias
```

Para experimentar sem tocar na sua home real, aponte a home para uma pasta qualquer:

```sh
SKM_HOME=/tmp/fake-home skm list
```

Estrutura:

```
bin/skm.mjs      CLI
src/core/        lógica de arquivos (scan, ações)
src/server.mjs   servidor HTTP + API JSON
src/ui/          interface (HTML, JS e CSS, tema HFPS)
docs/ARCHITECTURE.md   contrato completo (modelo, ações, API)
```
