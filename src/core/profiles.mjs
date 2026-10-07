import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from './config.mjs';
import { assertName, resolveContext, SkmError } from './context.mjs';
import { scanScope } from './scan.mjs';

export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_PROFILE_SKILLS = 200;

/** Profiles live next to the config file, in their own file so a setup is easy to share. */
export const profilesPath = (home) => path.join(home, '.config', 'skm', 'profiles.json');

/** Trim + lowercase, then enforce `[a-z0-9-]`, 1..48 characters, starting with a letter or digit. */
export function normalizeProfileName(name) {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!PROFILE_RE.test(n)) {
    throw new SkmError('invalid', `invalid profile name ${JSON.stringify(name)}: use 1-48 characters from a-z, 0-9 and "-"`);
  }
  return n;
}

/** Validated skill names, de-duplicated and sorted. At least one, at most MAX_PROFILE_SKILLS. */
function normalizeSkills(skills) {
  if (!Array.isArray(skills)) throw new SkmError('invalid', 'skills must be an array of skill names');
  const out = [...new Set(skills.map((s) => assertName(typeof s === 'string' ? s.trim() : s)))].sort();
  if (!out.length) throw new SkmError('invalid', 'a profile needs at least one skill');
  if (out.length > MAX_PROFILE_SKILLS) throw new SkmError('invalid', `at most ${MAX_PROFILE_SKILLS} skills per profile`);
  return out;
}

function readRaw(home) {
  try {
    const data = JSON.parse(fs.readFileSync(profilesPath(home), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** The `profiles` object of the raw file (a fresh copy; malformed means empty). */
function rawProfiles(raw) {
  const p = raw.profiles;
  return p && typeof p === 'object' && !Array.isArray(p) ? { ...p } : {};
}

/** Lenient read of one stored entry: names that are not valid skill names are dropped. */
function sanitize(name, entry) {
  const skills = Array.isArray(entry?.skills) ? entry.skills.filter((s) => typeof s === 'string' && s && !s.startsWith('.') && !/[\\/\0]/.test(s)) : [];
  return { name, skills: [...new Set(skills)].sort() };
}

/** Read-modify-write of the profiles file: `mutate(profiles)` changes the object in place; other keys survive. */
function writeProfiles(home, mutate) {
  const raw = readRaw(home);
  const profiles = rawProfiles(raw);
  mutate(profiles);
  const next = { ...raw, profiles };
  if (!Object.keys(profiles).length) delete next.profiles;
  writeJsonFile(profilesPath(home), next);
}

/** Every stored profile as [{ name, skills }], sorted by name. A missing or invalid file means none. */
export function readProfiles(opts = {}) {
  const { home } = resolveContext(opts);
  return Object.entries(rawProfiles(readRaw(home)))
    .filter(([name]) => PROFILE_RE.test(name))
    .map(([name, entry]) => sanitize(name, entry))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** One profile by name; throws `not-found`. */
export function getProfile(opts, name) {
  const n = normalizeProfileName(name);
  const p = readProfiles(opts).find((x) => x.name === n);
  if (!p) throw new SkmError('not-found', `no profile named "${n}"`);
  return p;
}

/** Create a profile (`exists` unless `overwrite`, which replaces its skill list). Returns { name, skills }. */
export function saveProfile(opts, { name, skills, overwrite = false } = {}) {
  const { home } = resolveContext(opts);
  const n = normalizeProfileName(name);
  const list = normalizeSkills(skills);
  writeProfiles(home, (profiles) => {
    if (profiles[n] && !overwrite) throw new SkmError('exists', `profile already exists: ${n} (use overwrite)`);
    profiles[n] = { ...(profiles[n] && typeof profiles[n] === 'object' ? profiles[n] : {}), skills: list };
  });
  return { name: n, skills: list };
}

/**
 * Rename a profile and/or change its members. `req`: { name, rename?, skills? (replace), addSkills?, removeSkills? }.
 * Replace applies first, then add, then remove; the result must keep at least one skill. Returns { name, skills }.
 */
export function updateProfile(opts, req = {}) {
  const { home } = resolveContext(opts);
  const current = getProfile(opts, req.name);
  for (const k of ['skills', 'addSkills', 'removeSkills']) if (req[k] !== undefined && !Array.isArray(req[k])) throw new SkmError('invalid', `${k} must be an array of skill names`);
  let skills = req.skills === undefined ? current.skills : normalizeSkills(req.skills);
  if (req.addSkills) skills = normalizeSkills([...skills, ...req.addSkills]);
  if (req.removeSkills) {
    const drop = new Set(req.removeSkills);
    skills = normalizeSkills(skills.filter((s) => !drop.has(s)));
  }
  const to = req.rename === undefined ? current.name : normalizeProfileName(req.rename);
  writeProfiles(home, (profiles) => {
    if (to !== current.name && profiles[to]) throw new SkmError('exists', `profile already exists: ${to}`);
    const entry = profiles[current.name] && typeof profiles[current.name] === 'object' ? profiles[current.name] : {};
    delete profiles[current.name];
    profiles[to] = { ...entry, skills };
  });
  return { name: to, skills };
}

/** Remove a profile; returns what was removed (so a caller can offer undo). Skill folders are never touched. */
export function deleteProfile(opts, name) {
  const { home } = resolveContext(opts);
  const p = getProfile(opts, name);
  writeProfiles(home, (profiles) => delete profiles[p.name]);
  return p;
}

/** Names of the active skills of the context's project, sorted. */
export function projectSkillNames(opts) {
  const ctx = resolveContext(opts);
  if (!ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  return [...new Set(scanScope(ctx, 'local').filter((s) => s.active).map((s) => s.name))].sort();
}

/** Store the project's active skills as a profile (`exists` unless `overwrite`). Returns { name, skills }. */
export function saveProjectProfile(opts, { name, overwrite = false } = {}) {
  const ctx = resolveContext(opts);
  const skills = projectSkillNames(ctx);
  if (!skills.length) throw new SkmError('invalid', `${ctx.project.name} has no active skills to save`);
  return saveProfile(ctx, { name, skills, overwrite });
}
