import fs from 'node:fs';
import { readRaw, updateRaw } from './config.mjs';
import { resolveContext, SkmError } from './context.mjs';
import { normalizeTags, TAG_RE, MAX_TAGS } from './meta.mjs';

export const STATUSES = ['active', 'paused', 'archived'];
export const MAX_DESCRIPTION = 300;
export const MAX_NOTES = 2000;

const emptyMeta = () => ({ description: '', tags: [], status: '', notes: '' });
const isEmpty = (m) => !m.description && !m.tags.length && !m.status && !m.notes;
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Lenient read for stored entries: whatever is malformed is dropped rather than failing the whole scan. */
function sanitize(entry) {
  if (!isObject(entry)) return emptyMeta();
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string' && TAG_RE.test(t)) : [];
  return {
    description: typeof entry.description === 'string' ? entry.description.slice(0, MAX_DESCRIPTION) : '',
    tags: [...new Set(tags)].sort().slice(0, MAX_TAGS),
    status: STATUSES.includes(entry.status) ? entry.status : '',
    notes: typeof entry.notes === 'string' ? entry.notes.slice(0, MAX_NOTES) : '',
  };
}

/** absolute project path -> { description, tags, status, notes } for every non-empty entry in the config file. */
export function readProjectMeta(opts = {}) {
  const { home } = resolveContext(opts);
  const projects = readRaw(home).projects;
  const map = new Map();
  if (!isObject(projects)) return map;
  for (const [root, entry] of Object.entries(projects)) {
    const m = sanitize(entry);
    if (!isEmpty(m)) map.set(root, m);
  }
  return map;
}

/** Meta of one project from a `readProjectMeta` map (a fresh object; all fields present, `status` is "" when never set). */
export function projectMetaFor(map, root) {
  let m = map.get(root);
  if (!m) {
    try {
      m = map.get(fs.realpathSync(root));
    } catch {}
  }
  return m ? { ...m, tags: [...m.tags] } : emptyMeta();
}

function text(req, key, max) {
  const v = req[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new SkmError('invalid', `${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new SkmError('invalid', `${key} is ${t.length} characters (max ${max})`);
  return t;
}

/**
 * Change the meta of the project at `root` (absolute; the caller has already applied the project guard).
 * `req`: { description?, notes?, status? ("" clears), tags? (replace), addTags?, removeTags? }. Replace applies first,
 * then add, then remove. An entry left empty is removed. Every other key of the config file is preserved. Returns the meta.
 */
export function writeProjectMeta(opts, root, req) {
  const ctx = resolveContext(opts);
  if (!isObject(req)) throw new SkmError('invalid', 'body must be an object');
  for (const k of ['tags', 'addTags', 'removeTags']) if (req[k] !== undefined && !Array.isArray(req[k])) throw new SkmError('invalid', `${k} must be an array of strings`);
  const description = text(req, 'description', MAX_DESCRIPTION);
  const notes = text(req, 'notes', MAX_NOTES);
  if (req.status !== undefined && req.status !== '' && !STATUSES.includes(req.status)) throw new SkmError('invalid', `status must be one of ${STATUSES.join(', ')} (or "" to clear)`);

  const current = projectMetaFor(readProjectMeta(ctx), root);
  let tags = req.tags === undefined ? current.tags : normalizeTags(req.tags);
  if (req.addTags) tags = normalizeTags([...tags, ...req.addTags]);
  if (req.removeTags) {
    const drop = new Set(normalizeTags(req.removeTags));
    tags = tags.filter((t) => !drop.has(t));
  }
  const meta = { description: description ?? current.description, tags, status: req.status ?? current.status, notes: notes ?? current.notes };
  if (JSON.stringify(meta) === JSON.stringify(current)) return meta; // nothing to write

  updateRaw(ctx, (raw) => {
    const projects = isObject(raw.projects) ? { ...raw.projects } : {};
    if (isEmpty(meta)) delete projects[root];
    else projects[root] = meta;
    const next = { ...raw, projects };
    if (!Object.keys(projects).length) delete next.projects;
    return next;
  });
  return meta;
}
