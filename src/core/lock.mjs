import fs from 'node:fs';
import path from 'node:path';

export const lockPath = (home) => path.join(home, '.agents', '.skill-lock.json');

/**
 * Read the `npx skills` lock file. Returns null when it is missing or invalid (no provenance).
 * `data` is the parsed document; `indent` and `newline` are kept so a write leaves the format alone.
 */
export function readLock(home) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath(home), 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!data.skills || typeof data.skills !== 'object' || Array.isArray(data.skills)) data.skills = {};
  return { data, indent: /^[ \t]+(?=")/m.exec(raw)?.[0] ?? '  ', newline: raw.endsWith('\n') };
}

/** The lock entry of one skill, or null. */
export const lockEntry = (lock, name) => {
  const e = lock?.data.skills[name];
  return e && typeof e === 'object' ? e : null;
};

/** Write the lock back (temp file + rename, same folder). Unknown fields are whatever `data` still holds. */
export function writeLock(home, { data, indent, newline }) {
  const file = lockPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, indent) + (newline ? '\n' : ''));
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
