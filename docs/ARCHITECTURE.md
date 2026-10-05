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

## Provenance, outdated check and update (global scope only)

The `npx skills` CLI records where each global skill came from in `<home>/.agents/.skill-lock.json`:
`{ "version": 3, "skills": { "<name>": { "source": "owner/repo", "sourceType": "github", "sourceUrl",
"skillPath": "skills/<name>/SKILL.md", "skillFolderHash": "<git tree sha of the skill folder>",
"installedAt", "updatedAt", "pluginName"? } }, "dismissed": {...}, "lastSelectedAgents": [...] }`.
skm reads it (never requires it: a missing or invalid file means "no provenance") and writes it
only on `update`, preserving every unknown field, the file's indentation and the other skills,
atomically (temp file + rename).

`skillFolderHash` is the git tree SHA of the skill folder. skm computes the same hash locally
(git tree hashing in JS: `blob <n>\0`, `tree <n>\0` entries sorted with directories compared as
`name/`, modes `100644`, `100755`, `40000`, `120000`; ignore `.git` and `.DS_Store`). Verified:
it matches the lockfile on the real installed skills. Local hash != lock hash means the skill
was **modified locally**.

Remote check: one GitHub API call per distinct repo, `GET /repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1`
(default branch from `GET /repos/{owner}/{repo}`), then find the tree entry for the folder of
`skillPath`. Auth is optional: `GITHUB_TOKEN`/`GH_TOKEN`, else `gh auth token` if `gh` exists,
else anonymous. Only `sourceType: "github"` is checked. The check is manual (never on page load).
Network and `git` access are injectable so tests never hit the network.

Check status per skill: `up-to-date` (remote hash == lock hash), `update-available` (differs),
`removed-upstream` (folder no longer exists in the repo, e.g. renamed), `unreachable` (network,
rate limit, repo gone; carries `error`). Skills without a lock entry have `origin: null` and are
never checked.

Update: `git clone --depth 1 <sourceUrl>` into a temp dir (uses the user's git credentials), take
the folder of `skillPath`, then: refuse with `code: "modified"` if the local copy is modified and
`force` is not set; move the old real folder to the system Trash (same helper as delete); copy the
new folder in place (an inactive skill stays inactive: update where the folder lives); set the
lock entry's `skillFolderHash` (from the clone: `git rev-parse HEAD:<folder>`) and `updatedAt`;
the `.claude` symlink is untouched. `removed-upstream` cannot be updated (`code: "removed-upstream"`).
`dryRun` lists the changes and touches nothing.

### API additions

`Skill` gains `origin`:
```json
"origin": null
```
or
```json
"origin": { "source": "google-gemini/gemini-skills", "url": "https://github.com/google-gemini/gemini-skills.git",
            "skillPath": "skills/gemini-interactions-api/SKILL.md", "installedAt": "2026-06-23T02:43:28.718Z",
            "updatedAt": "2026-06-23T02:43:28.718Z", "modified": false }
```
(`origin` is only ever non-null for `scope: "global"`; `modified` is computed on every `/api/state`.)

`GET /api/updates` (runs the remote check, can take seconds; always JSON) ->
```json
{ "checkedAt": "2026-10-05T20:00:00.000Z",
  "results": { "gemini-interactions-api": { "status": "removed-upstream" },
               "wrangler": { "status": "update-available", "remoteHash": "abc..." },
               "orca-cli": { "status": "up-to-date" },
               "foo": { "status": "unreachable", "error": "rate limited" } } }
```
`POST /api/action` accepts `{ "action": "update", "scope": "global", "name": "...", "force": false, "dryRun": false }`.
Errors: `modified` (409-style 4xx), `removed-upstream`, `not-tracked`, `not-found`, `network`.

### CLI additions

```
skm outdated [--json]            run the check; table: name, source, status (exit code 0 always)
skm update <name> [--force] [--dry-run] [--yes]
skm update --all [--force] [--dry-run] [--yes]    only update-available, skips modified unless --force
```
`skm list` shows an `ORIGIN` column (repo or `-`) and a `modified` marker; `skm doctor` unchanged.
Confirmation (TTY, skipped by `--yes`/`--dry-run`) says the old version goes to the system Trash.

## Context cost, lint, update diff, projects

Only `.agents` and `.claude` are supported as skill roots (the ecosystem is converging on `.agents`).
No agent-specific plugins, no installer (use `npx skills`), no Syncthing conflict resolver.

### Context cost

Active skills cost context in every session: the agent loads each skill's `name` + `description`
(frontmatter) up front, and the whole `SKILL.md` body when the skill is invoked. Token estimate:
`Math.ceil(chars / 4)` (documented as an approximation, never presented as exact).

`Skill.cost = { "listing": 112, "full": 4310 }` (`listing` = name + description, `full` = whole SKILL.md).
A skill present in both `.agents` and `.claude` (symlink or copy) counts once. Inactive skills have
`cost` but are excluded from totals. `GET /api/state` adds
`"totals": { "global": { "active": 10, "listingTokens": 1450 }, "local": { "active": 1, "listingTokens": 90 }, "listingTokens": 1540 }`.
CLI: `skm cost [--json]` (table sorted by listing cost desc, with totals, active only unless `--all`);
`skm list` gets a `TOK` column (listing tokens).

### Lint

`Skill.lint = [{ "rule": "name-mismatch", "severity": "warn", "message": "..." }]` (empty array when clean).
Rules (severity): `no-skill-md` error (folder without SKILL.md), `bad-frontmatter` error (missing or
unparseable `---` block), `missing-name` error, `missing-description` error, `name-mismatch` warn
(frontmatter name != folder name), `name-invalid` warn (not lowercase letters/digits/hyphens or > 64 chars),
`description-long` warn (> 1024 chars), `description-short` warn (< 40 chars), `no-trigger-hint` info
(description never says when to use it: no "use when", "trigger", "when the user", "use this skill",
"use for" or similar), `broken-reference` warn (a relative markdown link or `references/...`,
`scripts/...`, `assets/...` path mentioned in SKILL.md that does not exist in the folder), `skill-md-large`
info (> 500 lines). `GET /api/state` skills carry `lint`; the existing `issues` array is unchanged
(`lint` is additive and content-based, `issues` stays about layout).
CLI: `skm lint [name] [--json] [--all]` prints findings grouped by skill; exit code 1 if any `error`.

### Update diff

`GET /api/diff?name=<global skill name>` -> compares the installed folder with the upstream folder
(same clone logic as update, temp dir cleaned afterwards):
```json
{ "name": "wrangler", "from": "45cc198", "to": "2dab137",
  "stats": { "added": 1, "removed": 0, "modified": 2, "insertions": 40, "deletions": 12 },
  "files": [ { "path": "SKILL.md", "status": "modified", "binary": false,
               "hunks": [ { "oldStart": 3, "oldLines": 4, "newStart": 3, "newLines": 6,
                            "lines": [" context", "-removed", "+added"] } ] } ] }
```
`status` is `added | removed | modified`; binary files have `binary: true` and no hunks; 3 lines of context;
zero-dependency line diff (Myers or LCS). Errors as documented for update (`not-tracked`, `removed-upstream`,
`network`). Since the diff is installed -> upstream, local edits show up as removals: the UI/CLI explain that.
CLI: `skm diff <name>` (colored unified output, `--json`), and `skm update` (TTY) prints the diff stat
before the confirmation.

### Projects (user-configured scan roots)

Config file `<home>/.config/skm/config.json`, created only when the user changes something:
`{ "projectRoots": ["~/orca/projects", "~/Documents"], "scanDepth": 3 }` (`~` expanded at read time, defaults:
no roots, depth 3). The scan looks, under each root up to `scanDepth` levels, for directories that contain
`.agents/skills` or `.claude/skills` with at least one skill; it skips `node_modules`, `.git`, `.Trash`, dot
folders (except the `.agents`/`.claude` it looks for), does not follow symlinked directories and never
descends into a found project. No roots configured means the Projects view asks the user to add some;
nothing is scanned by default.

`GET /api/config` -> `{ "projectRoots": [...], "scanDepth": 3 }`;
`PUT /api/config` body same shape (validates: array of existing directories, depth 1..6) -> same shape or 4xx JSON error.
`GET /api/projects` ->
```json
{ "roots": ["/Users/me/orca/projects"],
  "projects": [ { "root": "/Users/me/orca/projects/foo", "name": "foo",
                  "skills": [ { "name": "release-notes", "active": true, "status": "ok", "cost": { "listing": 40, "full": 900 } } ] } ],
  "repeated": [ { "name": "release-notes", "projects": ["/Users/me/orca/projects/foo", "/Users/me/Documents/bar"],
                  "inGlobal": false, "identical": true } ] }
```
`repeated` = the same skill name in 2+ projects (`identical` compares folder hashes). `POST /api/action`
accepts an optional `"projectRoot": "/abs/project"` (must be inside a configured root or be the current
project): the action runs with that project as the local scope, so `promote`, `copyToLocal`, `activate`,
`deactivate`, `delete` work on any scanned project.
CLI: `skm projects` (scan and list, `--json`), `skm projects add <path>`, `skm projects rm <path>`,
`skm projects depth <n>`, `skm config` (prints the file path and content).
