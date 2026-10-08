# Planned: CLAUDE.md / AGENTS.md management

Status: Phase 1 shipped (2026-10-07); Phase 2 (editing) planned.

## Why

skm already knows where every project lives and which skills are active in each. The other half of what steers an
agent in a project is its instruction files (`CLAUDE.md`, `AGENTS.md`), and those are scattered, often duplicated and
easy to let drift apart. skm is a good place to see them in one view.

## Scope

Instruction files are free text, unlike skills, which are folders with a clear contract. So this ships in two phases and
the second only if the first leaves something missing.

### Phase 1: read only

- List, per project, which instruction files exist: `CLAUDE.md`, `AGENTS.md`, and the global `~/.claude/CLAUDE.md`.
- Flag when a project has both and they differ, or when one is a plain copy of the other.
- Show a diff between two of them.
- Surface this in the web UI (project detail) and the CLI (`skm projects show`, or a new `skm instructions`).
- No writes of any kind.

### Phase 2: editing

- Edit a file from the UI, and from the CLI (`skm instructions edit <project> <file>`).
- Every write follows the existing action model: dry-run first, the previous version moved to the Trash (never
  overwritten in place), and a plain-text confirmation of what changes.
- Optional: "sync" one file from the other, with the diff shown before applying.

## Open questions

- Which names count: only `CLAUDE.md` and `AGENTS.md`, or also nested ones, `.claude/CLAUDE.md`, `CLAUDE.local.md`?
- Should the global file be edited from the UI at all, given it is the most personal one?
- Is a symlink from one to the other a valid state to preserve, rather than flag as a duplicate?

## Out of scope

- Judging the content (linting prose, size budgets).
- Generating instruction files with a model.

## Decisions (2026-10-07)

- This change ships Phase 1 (read only). Phase 2 (editing) stays planned.
- Files that count: `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` at the project root, plus the global
  `~/.claude/CLAUDE.md`. Nested files deeper in the tree are out of scope for now.
- A symlink from one instruction file to another is a valid state: report it as a link, not as a duplicate.

## Agent skill

When this ships, update `skills/skm/SKILL.md` (the skill that teaches the agent to use skm) so the agent knows the new instruction-file commands (listing, diffing and, later, editing CLAUDE.md / AGENTS.md), and refresh the README and `docs/ARCHITECTURE.md` in the same change. Part of the definition of done, not a follow-up.
