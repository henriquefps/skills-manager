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
Windows: no real Recycle Bin (plain moves cannot write to it); the folder goes to skm's own
`%LOCALAPPDATA%\skm\Trash\<name>` (else `<home>\AppData\Local\skm\Trash`), same unique-name rule as macOS.
Symlinks use `dir` symlinks, falling back to junctions on EPERM/EACCES. Other platforms: `SkmError("unsupported")`. The folder is moved (`moveSync`, so cross-device works),
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
| `refresh` | global -> local | replace each real local folder that differs from the global copy (active or inactive, only read) with that copy; old folder to the system Trash. See below |
| `delete` | global/local | move real folders to the system Trash, unlink symlinks (global also removes claude symlink) |
| `applyProfile` | global -> local | copy every skill of a profile into the project; see "Profiles (skill kits)" |

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
skm refresh <name...>   replace the local copy with the global one (aka refresh)
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
no roots, depth 3). The scan looks, under each root up to `scanDepth` levels, for projects. A directory is a
project if **any** of these holds: it has a `.git` entry (directory or file, so worktrees count); it has
`.agents/skills` or `.claude/skills` with at least one skill; or it has a strong single-project marker file:
`package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `config.xml`, `plugin.xml`,
`Package.swift`, `pubspec.yaml`, `build.gradle`, `build.gradle.kts`, or any `*.xcodeproj`, `*.csproj`, `*.sln`, `*.oml`, `*.oap`.
Markers are included because the scan feeds the project index (below): an agent must be able to find a project
even when it has no skills yet and no git repository, so a project with zero skills still appears (`skills: []`)
in `skm projects`, `find`, `show`, `set`, `GET /api/projects` and the Projects tab. `pubspec.yaml` (Flutter) is there
because otherwise the `android/`, `ios/` and `macos/` folders of a Flutter app are listed as separate projects.
The scan skips `node_modules`, `.git`, `.Trash`, dot folders, does not follow symlinked directories, never
descends into a found project and never treats the home directory itself as a project. A folder with none of the
above (a plain container) is not listed, but its children are examined. Known limit: a container folder with a stray
`package.json` (or a `.git`) counts as one project and hides the real projects below it. No roots configured means
the Projects view asks the user to add some;
nothing is scanned by default.

`GET /api/config` -> `{ "projectRoots": [...], "scanDepth": 3 }`;
`PUT /api/config` body same shape (validates: array of existing directories, depth 1..6) -> same shape or 4xx JSON error.
`GET /api/projects` (a project without skills has `"skills": []`) ->
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

## Favorites, tags and copying from inactive skills

Inactive global skills are a repository: the user keeps skills switched off and copies them into a project when
needed. Two changes support that.

1. `copyToLocal` (`skm pull`, "Copy to local") accepts a global skill that is **inactive** (found in
   `~/.agents/skills-inactive`, or `~/.claude/skills-inactive` as a real folder). The copy is a real folder in the
   project's skills dir and is active; the global skill stays inactive and untouched. Error text for a missing
   skill becomes `no global skill: <name>`. (Before this, only active skills could be copied: a bug.)
2. Favorites and tags, stored in the same config file as the project roots: `<home>/.config/skm/config.json`
   gains `"skills": { "<name>": { "favorite": true, "tags": ["mobile", "saas"] } }`. Keyed by skill name only, so one
   entry covers the active and inactive copy and any scope. Entries with `favorite: false` and no tags are removed.
   Reading and writing the config must **preserve all keys** (`projectRoots`, `scanDepth`, `skills`, and unknown
   ones); `PUT /api/config` validates and updates only `projectRoots` and `scanDepth` and never drops `skills`.
   Tag rules: lowercase, `[a-z0-9-]`, 1..24 chars, at most 8 per skill, de-duplicated, stored sorted.

`Skill` gains `meta: { "favorite": false, "tags": [] }` on every skill in `/api/state` and `/api/projects`
skill entries (same name-keyed lookup). `GET /api/state` also gains `"tags": [ { "tag": "mobile", "count": 3 } ]`
(all tags in use, sorted by count desc then name) and `"favorites": 4` (count of favorite skills present on disk).

`POST /api/meta` body `{ "name": "wrangler", "favorite": true, "addTags": ["saas"], "removeTags": ["old"] }`
(every field optional, `tags` may replace the whole list instead of add/remove) -> `{ "ok": true, "meta": { ... } }`;
errors as JSON (`invalid` for bad tags). Cross-origin requests are refused like the other writes.

Batch copy: `POST /api/action` with `{ "action": "copyToLocal", "names": ["a", "b"], "scope": "global", "overwrite": false,
"target": "claude", "dryRun": false, "projectRoot": "..."? }` -> `{ "ok": true|false, "message": "...", "changes": [...],
"results": [ { "name": "a", "ok": true }, { "name": "b", "ok": false, "error": "...", "code": "exists" } ] }`.
It continues past failures; top-level `ok` is true only if every item succeeded. `name` (single) keeps working.

CLI:
```
skm fav <name...>           mark as favorite          skm unfav <name...>
skm tag <name> <tag...>     add tags                  skm untag <name> <tag...>
skm tags                    list tags in use with counts
skm list [--fav] [--tag <t>]   filters (combine with --json); list shows FAV (*) and TAGS columns
skm pull <name...>          several names at once (same options)
```
Names that are not on disk are rejected for `fav`/`tag` (`not-found`) so typos do not create entries.

## Refresh a local skill from the global copy

When a project skill and a global skill share a name but not content, and the global one is the one to keep.

- `vsGlobal` on local skills in `GET /api/state` and on project skill entries in `/api/projects`: `"identical"`,
  `"diverged"` or `null` (no global skill of that name, or the local skill has only links). It compares every real
  local folder with the global source by folder hash. The global source is the same as for `copyToLocal`: active
  copies first, then inactive ones.
- Action `refresh` (scope `local`, the default): every real local folder that differs from the global source goes to
  the system Trash and gets a copy of the global folder in its place. The global side is only read, so an inactive
  global skill stays inactive. An inactive local skill is refreshed where it lives and stays inactive; local symlinks
  are left alone. Identical folders are a no-op (`changes: []`). Errors: `no-project`, `not-found` (no global or no
  local skill), `invalid` (the local skill is only links, or scope is not `local`). Takes `dryRun`, `projectRoot`, and
  `names` for a batch (same result shape as batch copy: `results` per name, continues past failures).
- `GET /api/diff?scope=local&name=<name>[&projectRoot=<abs>]` -> local -> global diff (same shape as the update diff,
  with `from: "local"`, `to: "global"` and the two folder paths), so local edits show up as removals.
- UI: a "Differs from global" badge and an **Update local from global** button on the local skill card; in the
  Projects tab, a "Diverged from global" badge with **Update from global** per skill and **Update N from global** on a
  project card with several. One skill shows the diff before confirming, several show the batch dry run.
- CLI: `skm refresh <name...> [--dry-run] [--yes]` (in a project; prints the plan and the diff stat, then asks),
  `skm diff <name> --local [--json]`, and `skm list` marks diverged local skills `[differs]`. No "keep local edits"
  merge: the diff is the guard, and `promote --overwrite` is the opposite direction.

## Project index for agents (metadata, find, show, set) and the `skm` skill

Goal: an agent can resolve "that sync plugin I built" to a path and understand what it is, without the user pasting paths.
Two layers: **auto** facts computed on every scan (never stored) and **meta** written by the user (stored).

### Stored meta

`<home>/.config/skm/config.json` gains
`"projects": { "/abs/path/to/project": { "description": "...", "tags": ["work", "outsystems"], "status": "active", "notes": "..." } }`
keyed by **absolute project path**. Same preservation rule as everything else in that file (never drop other keys).
Rules: `description` <= 300 chars, `notes` <= 2000, `status` one of `active | paused | archived`, tags follow the skill tag rules
(lowercase `[a-z0-9-]`, 1..24 chars, max 8, sorted, de-duplicated). Entries that end up empty are removed. Setting meta requires
the path to exist and to be a found project (inside a configured root, with or without skills, see the scan rule above) or the current project.

### Auto facts (computed, injectable `git` runner, every call best effort, short timeouts, failures leave the field absent)

`auto: { "remote": "github.com/owner/repo", "branch": "main", "lastCommitAt": "2026-10-04T18:20:00.000Z",
"stack": ["node", "react", "vite", "tailwind", "shadcn"], "readme": "first paragraph, plain text, max 200 chars" }`
- `remote`: `git remote get-url origin`, normalized to `host/owner/repo`; **credentials never appear** (strip `user:pass@`,
  tokens, ssh `git@host:` form converted). Absent when there is no remote.
- `branch`, `lastCommitAt` from git (`git rev-parse --abbrev-ref HEAD`, `git log -1 --format=%cI`). No `git status` (slow).
- `stack`: from marker files, deterministic, sorted, deduplicated: `package.json` -> `node` plus dependency hints
  (`react`, `next`, `vue`, `svelte`, `vite`, `tailwind`, `typescript`, `express`, `capacitor`, `cordova`), `components.json` -> `shadcn`,
  `pyproject.toml`/`requirements.txt` -> `python`, `Cargo.toml` -> `rust`, `go.mod` -> `go`, `config.xml` or `plugin.xml` -> `cordova`,
  `*.csproj` -> `dotnet`, `Package.swift` or `*.xcodeproj` -> `swift`, `build.gradle(.kts)` -> `android`, `*.oml` or `*.oap` -> `outsystems`.
- `readme`: first paragraph of `README.md` (case-insensitive) that is not a heading, badge, image or HTML line; markdown stripped.

### API

Project entries in `GET /api/projects` gain `meta` and `auto`:
```json
{ "root": "/Users/me/Documents/my-apps/react-apps", "name": "react-apps",
  "meta": { "description": "", "tags": [], "status": "", "notes": "" },
  "auto": { "remote": "github.com/me/react-apps", "branch": "main", "lastCommitAt": "2026-10-04T18:20:00.000Z",
            "stack": ["node", "react", "vite"], "readme": "Collection of React experiments." },
  "skills": [ ... ] }
```
`meta.status` is `""` when never set (treated as `active` everywhere). `GET /api/projects?q=<text>` filters with the same
matching as `find` (below). Archived projects are included in the API (the UI decides what to show).

`POST /api/project-meta` body `{ "root": "/abs/project", "description": "...", "notes": "...", "status": "paused",
"tags": ["a"] | "addTags": [...], "removeTags": [...] }` (all optional; `description: ""` clears) -> `{ "ok": true, "meta": {...} }`;
errors as JSON (`invalid`, `not-found`, `forbidden` for a root outside the configured roots). Same-origin guard like other writes.

### Matching and ranking (shared by `find` and `?q=`)

Case-insensitive, query split on whitespace, **every token must match** somewhere. Fields and weights (sum of best field per token):
name 5, tags 4, meta.description 3, stack 2, meta.notes 2, auto.readme 1, auto.remote 1, path 1. Ties by most recent `lastCommitAt`, then name.

### CLI

```
skm projects [--json] [--brief] [--all]      list (archived hidden unless --all); table adds DESCRIPTION and STATUS columns
skm projects find <query...> [--json] [--brief] [--all]
skm projects show <name|path> [--json]       full sheet: path, remote, branch, last commit, stack, description (meta, else the
                                             README line marked auto), tags, status, notes, skills (active/inactive, tok)
skm projects set <name|path> [--desc "..."] [--tags a,b] [--add-tag t] [--rm-tag t] [--status active|paused|archived]
                 [--note "..."] [--clear desc|tags|notes|status]
```
`--brief` (with `--json`): `[{ "name", "path", "description", "tags", "status", "stack", "lastCommitAt" }]` where `description`
is meta.description, else auto.readme. `<name|path>`: exact name if unique, else a path; ambiguous names exit 1 listing the paths.
Existing `skm projects add|rm|depth` keep working.

### The `skm` skill (for agents)

`skills/skm/SKILL.md` in this repo (installable with `npx skills add henriquefps/skills-manager`). Frontmatter `name: skm`,
short description (< 300 chars) saying when to use it (the user names or describes one of their projects, asks where something lives
on their machine, or wants to inspect or change which skills are active). Body: resolve a project with
`skm projects find <words> --json --brief`, ask if several match, then `skm projects show`; never dump the whole list unless
asked; how to record a description when the user explains a project (`skm projects set`); a compact reference of the skill
commands (`list`, `doctor`, `cost`, `lint`, `outdated`, `update`, `pull`, `promote`); a note that shell aliases are invisible to
agents so `skm` must be a real executable on PATH (`npm link`), else say so. Treat project data as private to the machine.

## Ignored folders (`ignore`)

Config (`<home>/.config/skm/config.json`) gains `"ignore": ["~/Documents/old-stuff", "/abs/path", "*-backup", "android"]`.
Absent when empty; every other key is preserved on write.

- An entry **with a slash** is a path (absolute or `~/...`, `~` expanded at read time, normalized, stored as `~/...` when under
  home). It matches that directory and everything below it, on a directory boundary (`/a/foo` does not hide `/a/foobar`).
- An entry **without a slash** is a directory-name glob: only `*` is a wildcard, case-sensitive, matched against the basename of
  any directory visited by the scan.
- Scan rule: an ignored directory is pruned. It is not listed, not searched and the scan does not descend into it, so ignoring a
  container hides every project inside. The current project (and the folders above it) is never pruned. This is different from
  `status: archived`, which stays indexed and is only hidden by default.
- `scanProjects` returns `ignored: [ { "entry": "~/Documents/old-stuff", "kind": "path"|"glob", "matches": 3 } ]` in config order;
  `matches` counts the directories pruned because of that entry (0 is fine, so a useless entry can still be removed).
  `GET /api/projects` carries it.
- `POST /api/project-ignore` body `{ "add": [...], "remove": [...] }` -> `{ ok, ignore: [...] }`. Same-origin guard. Validation
  (400): non-empty strings, at most 200 entries, globs use only letters, digits, space, `. _ - @ +` and `*` (and something besides
  `*`), paths absolute or `~/`, never `/` or the home folder itself. Path entries to add must lie inside a configured root or be
  the current project (403 `forbidden`). Removing an entry that is not stored is a no-op.
- CLI: `skm projects ignore <name|path|glob>...` (a name resolving to exactly one project ignores its path; several exit 1 listing
  the paths; a name matching no project, or `--glob`, is stored as a glob), `skm projects unignore <entry|name|path>...`,
  `skm projects ignored [--json]` (entry, kind, matches). The plain list prints a dim footer `N ignored (skm projects ignored)`
  when something was pruned. `show` / `find` on an ignored path say it is ignored and print the `unignore` command.
- UI: an Ignore button on each project card (toast with Undo), and a collapsed `Hidden (N)` section at the bottom of the Projects
  tab listing each entry with kind, hidden count and a Remove button, plus a form to add a path or glob (errors inline).

## Profiles (skill kits)

A profile is a named list of skill names (no versions, no hashes), used to set up a project in one step.
Core: `src/core/profiles.mjs` (storage) and the `applyProfile` action in `src/core/actions.mjs`.

Storage: `<home>/.config/skm/profiles.json`, separate from `config.json` so it is easy to share, created on first
write, written atomically (`writeJsonFile` in `config.mjs`), every unknown key preserved (top level and per profile):
```json
{ "profiles": { "capacitor-react-shadcn": { "skills": ["capacitor-app-checklist", "cordova-plugins", "shadcn-ui"] } } }
```
Profile names: trimmed, lowercased, `^[a-z0-9][a-z0-9-]{0,47}$`. Skills: valid skill names (`assertName`), at least 1,
at most 200, de-duplicated and stored sorted. Names do not have to exist on disk (a shared profile may name skills
this machine lacks). A missing or invalid file means no profiles; malformed entries are dropped on read. A profile left
with no skills is refused; when the last profile is removed the `profiles` key is dropped.

Core API: `readProfiles`, `getProfile` (`not-found`), `saveProfile({ name, skills, overwrite })` (`exists` unless
`overwrite`), `updateProfile({ name, rename?, skills? | addSkills?, removeSkills? })` (rename onto an existing name is
`exists`), `deleteProfile(name)` (returns the removed profile; never touches skill folders),
`saveProjectProfile({ name, overwrite })` (the project's **active** local skills; `no-project`, or `invalid` when there
are none).

`applyProfile` (`POST /api/action` `{ "action": "applyProfile", "profile": "...", "target": "claude|agents",
"overwrite": false, "dryRun": false, "projectRoot"? }`): for each member, in profile order,
- a skill only **inactive** in the project is skipped (`reason: "inactive in this project"`), with or without overwrite;
- a skill already active in the project is skipped (`reason: "already in this project"`) unless `overwrite`, which
  replaces the real folder where it lives (the target root if it has one, else the other root), the old copy going to
  the system Trash; a symlink in the other root is left as it is;
- everything else goes through `copyManyToLocal` (grouped by root), so inactive global skills are valid sources, are
  copied as active project folders, and stay inactive in global. `not-found` there becomes `status: "missing"`.

Result: `{ ok, message, changes, results: [{ name, status: "copied"|"skipped"|"missing"|"failed", target?, reason?,
error?, code? }], copied, skipped, missing, failed }`. `ok` is false only when something `failed` (missing names are a
report, not a failure). `dryRun` plans and touches nothing.

HTTP: `GET /api/profiles` -> `{ "file": "/abs/.config/skm/profiles.json", "profiles": [{ "name", "skills" }] }`.
`POST /api/profiles` (same-origin guard) body `{ "op": "create"|"update"|"delete"|"saveProject", ... }` with the core
arguments above (`saveProject` takes an optional `projectRoot`, checked like `/api/action`) -> `{ ok, profile, profiles }`;
errors as JSON (`invalid`, `exists` 409, `not-found` 404, `forbidden` 403, `no-project`).

CLI:
```
skm profile list [--json]                 (bare `skm profile` lists too)
skm profile show <name> [--json]          members, global active/inactive/missing, and whether the project has each
skm profile save <name> [skill...] [--overwrite]    no skills = the current project's active skills
skm profile apply <name> [--overwrite] [--target agents|claude] [--dry-run] [--yes]
skm profile rm <name>                     prints the `skm profile save` line that recreates it
skm profile --help
```
`apply --overwrite` prints the plan and asks for confirmation (TTY; `--yes` skips it); exit 1 if any item failed.

UI: a **Profiles** tab (cards with members marked missing / inactive in global / already in the current project;
create, rename and edit members in a drawer, delete with Undo, "Save <project> as a profile"), **Apply to <project>** on
each profile card for the current project, and **Apply profile** / **Save as profile** on every project card in the
Projects tab. Apply opens the confirm dialog with a dry-run preview (target, overwrite) and ends with a per-skill
results dialog.

## Instruction files (CLAUDE.md / AGENTS.md), read only

Phase 1 of `docs/planned-features/instructions-management.md`. Core: `src/core/instructions.mjs`; nothing in it writes.

Files: `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` at the project root (`INSTRUCTION_FILES`, nested
files are out of scope) plus the global `<home>/.claude/CLAUDE.md` (id `global`; `home` is the injected one / `SKM_HOME`).

`listInstructions(opts, root?)` (root defaults to the current project; none = only the global file) ->
```json
{ "project": { "root": "/abs", "name": "atlas" } | null,
  "files": [{ "id": "AGENTS.md", "scope": "project", "path": "/abs/AGENTS.md", "kind": "file|symlink|broken-symlink",
              "target": "CLAUDE.md", "real": "/abs/CLAUDE.md", "linksTo": "CLAUDE.md",
              "bytes": 210, "lines": 13, "tokens": 53, "mtime": "..." }],
  "global": { "id": "global", "scope": "global", "kind": "file|symlink|broken-symlink|missing", ... },
  "pairs": [{ "a": "CLAUDE.md", "b": "AGENTS.md", "relation": "link|identical|differs" }],
  "findings": [{ "kind": "copy|differs|broken", "files": ["CLAUDE.md", "AGENTS.md"], "message": "..." }] }
```
`files` holds only the project files that exist. Files with the same real path are one file (`link` pair, `linksTo`
names the other one, preferring a regular file); copies with the same bytes are one content (`identical` pair, a `copy`
finding); only the first of each is compared with the rest, so a link or a copy never produces extra findings.
`differs` is a finding only between two of `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`; `CLAUDE.local.md` and the
global file are meant to differ. A link is valid and never a finding; a broken symlink is (`broken`).

`diffInstructions(opts, a, b, root?)`: `a`/`b` are an id from `INSTRUCTION_FILES`, `global` or `~/.claude/CLAUDE.md`
(anything else is `invalid`, so no arbitrary path is read). Uses `diffLines` from `diff.mjs` (old = a, new = b) and
returns the `diffTrees` shape so the CLI (`statLine`) and the UI (`diffView`) render it like a skill diff:
`{ a: { id, path }, b: { id, path }, project, relation, stats, files: [{ path: "CLAUDE.md -> AGENTS.md", status:
"modified", binary: false, hunks }] }` (`files` empty for `link` / `identical`). Errors: `not-found` (missing or broken),
`invalid` (unknown or the same file), `no-project`.

HTTP: `GET /api/instructions[?projectRoot=<abs>]` and `GET /api/instructions/diff?a=&b=[&projectRoot=<abs>]`;
`projectRoot` goes through `projectContext` (configured roots only, `forbidden` 403 otherwise).

CLI: `skm instructions [name|path] [--json]` (table, then findings with the `skm instructions diff` line to run),
`skm instructions diff <a> <b> [--project <name|path>] [--json]`; `skm projects show` adds an `instructions` row with
the findings, and `instructions` in its `--json`.

UI: **Instructions** on each project card opens a read-only drawer: the files (link, broken link, global badges, lines,
tokens), the findings with a **Show diff** each, and a Compare picker; the first `differs` (or copy) finding's diff is
shown on open. The mock server (`src/ui/mock/mock-server.mjs`) seeds atlas (CLAUDE.md and AGENTS.md differ), ledger
(AGENTS.md -> CLAUDE.md) and pixel-site (a plain copy, and a link to the global file).
