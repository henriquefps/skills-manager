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
| `skm cost` | context cost (estimated tokens) of the active skills |
| `skm lint [name]` | check SKILL.md content; exit 1 on errors |
| `skm outdated` | check tracked skills against their GitHub source |
| `skm update <name>` | update from the source (old version goes to the system Trash) |
| `skm pull <name...>` | copy a global skill, active or inactive, into the current project |
| `skm promote <name>` | copy a project skill to the global store |
| `skm activate\|deactivate <name>` | switch a skill on or off |

Add `--json` for structured output. Commands that delete or replace ask for confirmation; do not pass `--yes` unless
the user agreed.

## Privacy

Project paths, remotes and notes are private to this machine. Do not paste them into issues, commits, PRs or any
external service unless the user asks.
