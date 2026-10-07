---
name: skm
description: Use when the user names or describes one of their projects ("that sync plugin I built"), asks where something lives on their machine, or wants to inspect or change which agent skills are active. Resolves projects to paths with the skm CLI.
---

# skm: project index and skills manager

`skm` indexes the user's local projects (path, git remote, stack, description) and manages their agent skills.
Use it instead of asking the user to paste a path.

## Prerequisite

Run `skm --help` first. If it is not found, say so: `skm` must be a real executable on PATH (`npm link` in the
skills-manager repo). Shell aliases are invisible to agents, so an alias does not count. Do not guess paths instead.

## Find a project

1. `skm projects find <words> --json --brief` (every word must match; best match first). Use distinctive words from
   what the user said: a name, a technology, a purpose ("sync plugin", "react dashboard").
2. One clear match: use its `path`. Several plausible matches: show the `name` and `description` of each and ask which one.
   No match: retry with fewer or different words, then ask.
3. `skm projects show <name|path>` for the full sheet (remote, branch, last commit, stack, tags, notes, skills) before
   working in the project. A name shared by two projects exits with the paths: pass the path instead.

Never run a bare `skm projects` or dump the whole list unless the user asks for it. Archived projects are hidden
unless you pass `--all`.

## Record what a project is

When the user explains a project, save it so the next search finds it:

```
skm projects set <name|path> --desc "Background sync plugin for OutSystems mobile apps" --tags outsystems,plugin
skm projects set <name|path> --status paused --note "waiting on the API team"
skm projects set <name|path> --add-tag work --rm-tag old
skm projects set <name|path> --clear notes
```

Description max 300 chars, notes max 2000, tags lowercase `a-z0-9-` (max 8), status `active|paused|archived`.
Only write what the user told you or what you verified. Ask before overwriting an existing description.

Hide noise from the index with `skm projects ignore <name|path|glob>` (undo: `skm projects unignore <entry>`, list: `skm projects ignored`).
An ignored folder is not scanned at all, unlike archived. If a project is missing, check `skm projects ignored`.

## Skills commands

| Command | Use |
| --- | --- |
| `skm list [--json]` | global and current-project skills with status, tokens, tags |
| `skm doctor` | layout problems with the suggested fix |
| `skm check [--json] [--projects]` | health check: broken links, missing sources (errors), forgotten inactive folders, diverged same-name copies (hints); exit 1 on errors |
| `skm cost` | context cost (estimated tokens) of the active skills |
| `skm lint [name]` | check SKILL.md content; exit 1 on errors |
| `skm outdated` | check tracked skills against their GitHub source |
| `skm update <name>` | update from the source (old version goes to the system Trash) |
| `skm pull <name...>` | copy a global skill, active or inactive, into the current project |
| `skm refresh <name...>` | replace a project's copy of a skill with the global one (inactive global too); old copy to the Trash |
| `skm promote <name>` | copy a project skill to the global store |
| `skm activate\|deactivate <name>` | switch a skill on or off |
| `skm profile list\|show <name>` | named skill kits (profiles) and where each skill comes from |
| `skm profile apply <name> --dry-run` | preview copying a profile's skills into the current project |
| `skm profile apply <name>` | copy them: skips skills already there, reports names missing from global |
| `skm profile save <name> [skill...]` | save a list of skills, or with none the current project's active skills |

When the user starts a new project or asks to set it up "like" another one, run `skm profile list` and suggest a
matching profile; apply it from inside the project, with `--dry-run` first. `--overwrite` replaces existing project
skills (old copies go to the system Trash): only with the user's agreement.

When a skill does not load or the user asks what is wrong with their skills, run `skm check --json`. Each finding has
`type`, `severity` (`error` or `hint`), `message`, `paths` and `fixes` (`{ label, request: { action, scope, name, ... } }`);
the text output prints the matching `skm` command for each fix. Show the findings, propose the fix, run it with
`--dry-run` first and only then for real, with the user's agreement (deleted folders go to the system Trash). Hints are
advisory: an old inactive skill may be kept on purpose.

Add `--json` for structured output. Commands that delete or replace ask for confirmation; do not pass `--yes` unless
the user agreed.

## Privacy

Project paths, remotes and notes are private to this machine. Do not paste them into issues, commits, PRs or any
external service unless the user asks.
