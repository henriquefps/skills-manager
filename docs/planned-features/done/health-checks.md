# Planned: broken/orphan skills, and duplicates and conflicts

Status: shipped (2026-10-07).

## Broken and orphan skills

The scan already walks every skill folder, so it can report what is wrong:

- symlinks pointing at nothing;
- active skills whose source is missing;
- `skills-inactive` folders that were forgotten (nothing refers to them, old, or empty).

Shown as a Health view in the UI and `skm check` in the CLI, each finding with a suggested fix. Fixes go through the
existing actions (dry-run first, Trash instead of delete).

## Duplicates and conflicts

- The same skill name with different content in two places (this partly exists as `diverged` and the projects view's
  identical/diverged marks; the goal is to surface it in one place with the fix options).
- Two different skills whose `description` is so similar that they compete for activation. This one needs a similarity
  heuristic and will produce false positives, so it is advisory only.

## Open questions

- Which findings are errors and which are only hints?
- Is there a threshold for "similar descriptions" that is useful without being noisy?

## Decisions (2026-10-07)

- Errors: symlinks pointing at nothing, active skills whose source is missing.
- Hints: forgotten `skills-inactive` folders (unreferenced, old or empty), same name with diverged content.
- The description-similarity check is deferred; this change ships broken/orphan and same-name duplicates only.

## Agent skill

When this ships, update `skills/skm/SKILL.md` (the skill that teaches the agent to use skm) so the agent knows the new check output (broken/orphan findings and how to fix them) and the duplicate/conflict report, and refresh the README and `docs/ARCHITECTURE.md` in the same change. Part of the definition of done, not a follow-up.
