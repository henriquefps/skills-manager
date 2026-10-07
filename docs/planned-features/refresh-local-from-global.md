# Planned: refresh a local skill from the global copy

Status: planned. Partly available through the CLI (`skm pull <name> --overwrite`), not yet a clear flow in the UI.

## Why

A skill can exist locally and globally with different content. Sometimes the global one is the one you want, and the
local copy is just old. You should be able to replace the local skill with the global one in a single step, even when
the global skill is inactive.

## Scope

- When a local skill differs from a global skill of the same name, show an explicit **Update local from global** action
  (UI and CLI), next to the existing diverged choices.
- Works when the global skill is inactive (it is only read from, and stays inactive).
- Show the diff global -> local before confirming, the same way update does.
- The old local folder goes to the Trash; the global one is copied in.
- Dry-run and batch support, so it can refresh several skills at once.

## Open questions

- Should this be offered from the project's skill list, the projects index (the "diverged" mark), or both?
- Any local-only edits worth keeping? The diff is the guard; a "keep local" option is the opposite action (promote).

## Decisions (2026-10-07)

- Offered in both places: the project's skill list and the projects index's "diverged" mark.
- No "keep local edits" merge: the diff is the guard, and promote is the opposite action.

## Agent skill

When this ships, update `skills/skm/SKILL.md` (the skill that teaches the agent to use skm) so the agent knows the new refresh flow (updating a local skill from the global copy, including inactive ones), and refresh the README and `docs/ARCHITECTURE.md` in the same change. Part of the definition of done, not a follow-up.
