import path from 'node:path';
import { readRaw, updateRaw } from './config.mjs';
import { assertName, resolveContext, SkmError } from './context.mjs';
import { inspect } from './fsutil.mjs';

export const TAG_RE = /^[a-z0-9-]{1,24}$/;
export const MAX_TAGS = 8;

const emptyMeta = () => ({ favorite: false, tags: [] });
const sortedUnique = (tags) => [...new Set(tags)].sort();

/** Trim + lowercase, then enforce `[a-z0-9-]{1,24}`. */
function normalizeTag(tag) {
  const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!TAG_RE.test(t)) throw new SkmError('invalid', `invalid tag ${JSON.stringify(tag)}: use 1-24 characters from a-z, 0-9 and "-"`);
  return t;
}

/** Normalize a list of tags: validated, de-duplicated, sorted, at most MAX_TAGS. */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new SkmError('invalid', 'tags must be an array of strings');
  const out = sortedUnique(tags.map(normalizeTag));
  if (out.length > MAX_TAGS) throw new SkmError('invalid', `at most ${MAX_TAGS} tags per skill`);
  return out;
}

/** Lenient read for stored entries: whatever is malformed is dropped rather than failing the whole scan. */
function sanitize(entry) {
  if (!entry || typeof entry !== 'object') return emptyMeta();
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string' && TAG_RE.test(t)) : [];
  return { favorite: entry.favorite === true, tags: sortedUnique(tags).slice(0, MAX_TAGS) };
}

/** name -> { favorite, tags } for every non-empty entry in the config file. */
export function readMeta(opts = {}) {
  const { home } = resolveContext(opts);
  const skills = readRaw(home).skills;
  const map = new Map();
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return map;
  for (const [name, entry] of Object.entries(skills)) {
    const m = sanitize(entry);
    if (m.favorite || m.tags.length) map.set(name, m);
  }
  return map;
}

/** Meta of one skill from a `readMeta` map (a fresh object, so callers may keep it). */
export const metaFor = (map, name) => {
  const m = map.get(name);
  return m ? { favorite: m.favorite, tags: [...m.tags] } : emptyMeta();
};

/** True when a skill folder or link with that name exists in a global or local skills dir, active or not. */
function onDisk(ctx, name) {
  const scopes = ctx.project ? ['global', 'local'] : ['global'];
  return scopes.some((scope) => {
    const d = ctx.dirs(scope);
    return [d.agents, d.claude, d.agentsInactive, d.claudeInactive].some((dir) => inspect(path.join(dir, name)));
  });
}

/** Names must exist on disk, so a typo never creates an entry. */
export function assertSkillsExist(opts, names) {
  const ctx = resolveContext(opts);
  for (const n of names) if (!onDisk(ctx, assertName(n))) throw new SkmError('not-found', `no skill named "${n}"`);
}

/**
 * Change favorite/tags of one skill. `req`: { name, favorite?, tags? (replace), addTags?, removeTags? }.
 * Replace applies first, then add, then remove. An entry left with `favorite: false` and no tags is removed.
 * Returns the resulting meta.
 */
export function updateMeta(opts, req) {
  const ctx = resolveContext(opts);
  const name = assertName(req?.name);
  if (req.favorite !== undefined && typeof req.favorite !== 'boolean') throw new SkmError('invalid', 'favorite must be a boolean');
  for (const k of ['tags', 'addTags', 'removeTags']) if (req[k] !== undefined && !Array.isArray(req[k])) throw new SkmError('invalid', `${k} must be an array of strings`);
  assertSkillsExist(ctx, [name]);

  const current = metaFor(readMeta(ctx), name);
  let tags = req.tags === undefined ? current.tags : normalizeTags(req.tags);
  if (req.addTags) tags = normalizeTags([...tags, ...req.addTags]);
  if (req.removeTags) {
    const drop = new Set(req.removeTags.map(normalizeTag));
    tags = tags.filter((t) => !drop.has(t));
  }
  const meta = { favorite: req.favorite ?? current.favorite, tags };
  if (meta.favorite === current.favorite && meta.tags.join() === current.tags.join()) return meta; // nothing to write

  updateRaw(ctx, (raw) => {
    const skills = raw.skills && typeof raw.skills === 'object' && !Array.isArray(raw.skills) ? { ...raw.skills } : {};
    if (meta.favorite || meta.tags.length) skills[name] = meta;
    else delete skills[name];
    const next = { ...raw, skills };
    if (!Object.keys(skills).length) delete next.skills;
    return next;
  });
  return meta;
}

/** All tags in use over the given skills (by unique name): [{ tag, count }] sorted by count desc, then name. */
export function tagCounts(skills) {
  const counts = new Map();
  for (const s of new Map(skills.map((x) => [x.name, x])).values()) for (const t of s.meta.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
}
