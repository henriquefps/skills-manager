# skm: skills manager

Terminal command `skm` that manages agent skills (folders with a `SKILL.md`) across
global and project scopes. Zero dependencies, Node >= 20, ESM (`.mjs`).

## Layout

```
bin/skm.mjs            CLI entry (shebang, `bin` in package.json)
src/core/*.mjs         pure filesystem logic, no HTTP, no UI (unit tested)
src/server.mjs         node:http server: static UI + JSON API below
src/ui/                index.html, app.js, style.css (HFPS theme), no build step
test/                  node:test, always on temp dirs, never on the real $HOME
```

All filesystem roots are injectable (`home`, `cwd`) so tests run on temp dirs.

## Model

Canonical store (global): `~/.agents/skills/<name>/` (real folder).
Claude view (global): `~/.claude/skills/<name>` is a **symlink** (relative:
`../../.agents/skills/<name>`) to the canonical folder.
Inactive (global): `~/.agents/skills-inactive/<name>/`; the `~/.claude/skills` symlink is removed.
Trash: the real system Trash, never a folder inside the repo or `~/.agents`. macOS: `~/.Trash/<name>`
(on a name clash, ` <YYYY-MM-DD HH.MM.SS>` is appended, as Finder does). Linux (XDG):
`~/.local/share/Trash/files/<name>` plus `info/<name>.trashinfo` (`Path`, `DeletionDate`), unique name on a clash.
Other platforms: `SkmError("unsupported")`. The folder is moved (`moveSync`, so cross-device works),
so macOS "Put Back" is not guaranteed; restore by hand. Symlinks are only unlinked. See `src/core/trash.mjs`;
`home`, `platform` and `now` are injectable.

Local (project) scope, `<root>` = nearest ancestor of cwd with `.git`, `.agents` or `.claude`, else cwd:
`<root>/.agents/skills`, `<root>/.claude/skills`, `<root>/.agents/skills-inactive`,
`<root>/.claude/skills-inactive`. A local skill may live in
either root as a real folder (both copies is allowed, not required). Local inactive = moved
to the `skills-inactive` sibling of whichever root(s) held it. When a local `deactivate` moves a
folder there, it appends `skills-inactive/` to `<root>/.gitignore` unless that file is missing (never
created), not writable, the root has no `.git`, or an active line already mentions `skills-inactive`.

### Skill status (per name, per scope)

| status | meaning |
| --- | --- |
| `ok` | global: real folder in agents + claude symlink pointing to it. local: real folder present, no duplicate problem |
| `needs-link` | global: folder in agents, claude entry missing |
| `duplicate` | real folders in both agents and claude, byte-identical |
| `diverged` | real folders in both, contents differ |
| `claude-only` | real folder only in claude (global: should be adopted into agents) |
| `broken-link` | symlink whose target does not exist |
| `wrong-link` | claude symlink points somewhere other than the agents folder |
| `empty` | folder without `SKILL.md` |
| `conflict` | folder contains Syncthing `*.sync-conflict-*` files (flag, additive to other statuses via `issues`) |

`normalize` (global): make agents canonical (adopt claude-only, merge identical duplicates by
replacing the claude copy with the symlink; `diverged` is never auto-resolved: needs
`--keep agents|claude`), then create the claude symlink.

## Actions (core functions, CLI subcommands, and POST /api/action)

| action | scope | effect |
| --- | --- | --- |
| `activate` | global/local | move from `skills-inactive` back; global also recreates claude symlink |
| `deactivate` | global/local | move to `skills-inactive`; global also removes the claude symlink |
| `normalize` | global | see above; optional `keep: "agents"\|"claude"` for diverged |
| `promote` | local -> global | **copy** local skill to `~/.agents/skills/<name>` + claude symlink; fails if exists unless `overwrite` |
| `copyToLocal` | global -> local | **copy** to `<root>/.claude/skills/<name>` (or `.agents/skills` via `target: "agents"`); fails if exists unless `overwrite` |
| `delete` | global/local | move real folders to the system Trash, unlink symlinks (global also removes claude symlink) |

Every action takes `dryRun: true` and returns the planned `changes` without touching disk.

## CLI

```
skm                     start the UI for the current dir and open the browser (default port 4747)
skm list [--json]       table of global + local skills with status
skm doctor              list problems with the suggested fix
skm normalize [name|--all] [--keep agents|claude] [--dry-run]
skm activate|deactivate <name> [--local|--global]
skm promote <name>      local -> global (copy)
skm pull <name>         global -> local (copy)   (aka copyToLocal)
skm delete <name> [--local|--global]
```
Name resolution without `--local/--global`: unique match wins, otherwise ask/error.
Destructive actions ask for confirmation in a TTY unless `--yes`.

## HTTP API (JSON, same origin, bound to 127.0.0.1 only)

`GET /api/state` ->
```json
{
  "cwd": "/abs/path",
  "project": { "root": "/abs/project", "name": "project" },
  "global": [Skill],
  "local": [Skill]
}
```
`project` is `null` and `local` is `[]` when cwd has no project markers.

`Skill`:
```json
{
  "name": "orca-cli",
  "scope": "global",
  "active": true,
  "status": "ok",
  "issues": ["human readable problem", "..."],
  "description": "from SKILL.md frontmatter, may be empty",
  "files": 3,
  "bytes": 10240,
  "mtime": "2026-10-05T12:00:00.000Z",
  "locations": [
    { "root": "agents", "path": "/abs/..", "kind": "dir" },
    { "root": "claude", "path": "/abs/..", "kind": "symlink", "target": "../../.agents/skills/orca-cli" }
  ],
  "alsoIn": ["global"]
}
```
`kind` is `dir | symlink | broken-symlink`. `alsoIn` lists the other scope(s) that have a skill
with the same name (powers the "also global" / "also local" badges and promote/pull hints).
Inactive skills are in the same arrays with `active: false`.

`GET /api/skill?scope=global&name=orca-cli` ->
`{ "skill": Skill, "markdown": "<SKILL.md text>", "tree": ["SKILL.md", "references/a.md"] }`

`POST /api/action` body `{ "action": "...", "scope": "global|local", "name": "...", "dryRun": false, "keep": "agents|claude", "overwrite": false, "target": "agents|claude" }` ->
`{ "ok": true, "message": "...", "changes": ["move A -> B", "symlink C -> D"] }`
or HTTP 4xx `{ "ok": false, "error": "...", "code": "exists|diverged|not-found|..." }`.
Errors are always JSON. State is re-read from disk on every request (no cache).

## Visual identity

HFPS olive-neutral theme, Inter (the hfps.dev design system, `hfps-visuals` skill and its
`shared.css`; tokens `--bg --card --fg --muted-fg --border
--line --accent --accent-soft --accent-soft-border`, radius 16/20, eyebrow + title + deck +
white card). Also support dark mode via `prefers-color-scheme` with the same olive hue (107).
