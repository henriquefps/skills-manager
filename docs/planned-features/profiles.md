# Planned: profiles (skill kits) and project setups

Status: shipped (2026-10-07). See "Profiles (skill kits)" in docs/ARCHITECTURE.md.

## Why

Starting a project means re-picking the same skills by hand. Example: a Capacitor + React + shadcn app always wants the
same group. Batch copy exists, but the group itself is not saved anywhere.

## Scope

- A **profile** is a named list of skill names (e.g. `capacitor-react-shadcn`, `docs`), stored in skm's config.
- **Apply a profile** to a project: copy every skill in it into the project (same as `copyToLocal` with `names`),
  skipping the ones already there and reporting the ones that are missing from global.
- **Save a project's setup as a profile**: take the project's currently active skills and store them as a new profile.
  This doubles as export/import of a setup between projects.
- UI: a Profiles section (create, rename, edit members, delete) and an "Apply profile" action in the project view.
- CLI: `skm profile list|show|save|apply|rm`.
- Applying never overwrites without `--overwrite`, supports dry-run, and reuses the existing action model.

## Open questions

- Is a profile a list of names only, or does it pin a content hash / upstream version?
- Should applying a profile also activate inactive global skills, or only copy into the project?
- Where to store it: the existing config file, or a separate `profiles.json` that is easy to share?
- Export to a file others can import (a later step), or keep it local only?

## Decisions (2026-10-07)

- A profile is a list of skill names only; no content hash or version pinning.
- Stored in a separate `profiles.json` next to skm's config, so it is easy to share.
- Applying a profile only copies skills into the project; it does not activate inactive global skills (an inactive
  global skill is still a valid source to copy from).
- Export/import to a file is a later step, not part of this change.

## Agent skill

When this ships, update `skills/skm/SKILL.md` (the skill that teaches the agent to use skm) so the agent knows the new profile commands (`skm profile ...`) and when to apply one to a new project, and refresh the README and `docs/ARCHITECTURE.md` in the same change. Part of the definition of done, not a follow-up.
