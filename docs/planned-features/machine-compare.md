# Planned: compare global skills across paired computers

Status: documented only, not started (2026-11-04). Phase 1 is read only.

Decisions (2026-11-04): no per-machine exclusion needed (any paired machine may receive any skill); updates between
machines go over SSH. Everything else below is a proposal.

## Why

Every computer has skm and its own `~/.agents/skills`. Over time they drift: a skill is created or edited on one
machine and the others never get it. There is no quick way to answer "what does cachyos have that the mac lacks?".

Not wanted: realtime sync. Wanted: a button (and a command) that checks all paired computers on demand and shows the
differences.

## Scope

### Pairing (configuration)

A paired computer is an entry in `~/.config/skm/config.json`:

```json
{
  "machines": [
    { "name": "cachyos-fps", "ssh": "henriquefps@100.87.163.92", "skm": "skm", "enabled": true },
    { "name": "win-vm", "ssh": "henrique@100.104.128.114", "enabled": false }
  ]
}
```

- `name`: label shown in the UI.
- `ssh`: anything `ssh` accepts (user@host or an alias from `~/.ssh/config`). Tailscale IPs are fine.
- `skm`: optional command to run on the remote (default `skm`), for hosts where it is not on the PATH of a
  non-interactive shell.
- `enabled`: a paired machine can be switched off without losing the entry (e.g. the company VM, or a laptop that is
  often offline).
- CLI: `skm machines` (list), `skm machines add <name> <ssh>`, `skm machines remove <name>`,
  `skm machines test [name]` (reachability and skm version). UI: a Machines section in Settings.

### Phase 1: compare (read only)

- skm talks to the remote only through the `ssh` binary, `BatchMode=yes`, `ConnectTimeout=8`: no prompts, no new
  dependency, no daemon on the other side.
- New `skm inventory --json` (also usable by hand): for every global skill, its name, status and tree hash
  (`gitTreeHash`), plus whether it is active. The remote run is `ssh <host> skm inventory --json`. Machines are queried
  in parallel; an offline or failing one is reported as unreachable and never blocks the others.
- Compare by name and hash, per skill, against every paired machine:
  - `same`, `missing here`, `missing there`, `differs`.
  - Active vs inactive is shown but is not a difference (that state stays local to each computer).
- Show a diff for a `differs` skill: fetch the remote tree (`ssh <host> skm inventory --files <name>`, JSON with
  file contents, size-capped) and reuse `diffTrees`. Direction is "this machine -> that machine".
- Surface: `skm machines compare [name] [--json]`, `GET /api/machines/compare`, and a **Compare machines** button in
  the UI with a matrix (skills as rows, machines as columns, a cell per status) and the diff on click.
- No writes of any kind on either side.

### Phase 2: bring in line over SSH

Decided: updating is done over SSH too (same channel as the comparison).

- "Pull from <machine>" and "Push to <machine>" for one skill, following the existing action model: dry-run first, the
  replaced folder goes to the Trash, plain-text confirmation. Transfer by `ssh` + tar, not a new protocol.
- A diverged skill is never resolved automatically: the user picks the direction, as with `normalize --keep`.

## Decisions on the former open questions (2026-11-04)

- `inventory` returns whatever the comparison needs (name, status, hash, active, and more if a later view wants it). No
  fixed minimal set to defend.
- Windows is assumed to need its own handling (`cmd` quoting, paths, junctions). Treat it as a separate task to verify
  on the real VM when this is built; do not promise Windows support in Phase 1 before testing there.
- A remote with an old skm is not supported: it must be updated to the new skm first. skm reports "skm too old" with the
  remote version and does nothing else on that machine.

## Out of scope

- Realtime or scheduled sync, file watchers.
- Comparing project-local skills or instruction files across machines (could follow once global works).
- Running anything on the remote besides `skm inventory`.

## Agent skill

When this ships, update `skills/skm/SKILL.md` so the agent knows the `skm machines` and `skm inventory` commands, and
refresh the README and `docs/ARCHITECTURE.md` in the same change. Part of the definition of done, not a follow-up.
