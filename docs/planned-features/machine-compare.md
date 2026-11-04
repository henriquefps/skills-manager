# Planned: compare global skills across paired computers

Status: planned (2026-11-04). Phase 1 is read only.

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

### Phase 2: bring in line (only if Phase 1 leaves it missing)

- "Pull from <machine>" and "Push to <machine>" for one skill, following the existing action model: dry-run first, the
  replaced folder goes to the Trash, plain-text confirmation. Transfer by `ssh` + tar, not a new protocol.
- A diverged skill is never resolved automatically: the user picks the direction, as with `normalize --keep`.

## Open questions

- Skills that must not leave a machine (anything from the company VM): a per-machine `exclude` list, or just leave
  that machine un-paired?
- Should `inventory` include skill `lint` or `cost` data, or stay minimal (name, status, hash, active)?
- Windows remotes use `cmd` by default: is quoting the one `skm inventory` command enough, or does Windows need its
  own path?
- Version skew: an older skm on the remote may lack `inventory`. Report "skm too old" with the version, do not guess.

## Out of scope

- Realtime or scheduled sync, file watchers.
- Comparing project-local skills or instruction files across machines (could follow once global works).
- Running anything on the remote besides `skm inventory`.

## Agent skill

When this ships, update `skills/skm/SKILL.md` so the agent knows the `skm machines` and `skm inventory` commands, and
refresh the README and `docs/ARCHITECTURE.md` in the same change. Part of the definition of done, not a follow-up.
