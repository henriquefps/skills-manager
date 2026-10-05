import fs from 'node:fs';
import path from 'node:path';
import { SkmError } from './context.mjs';
import { moveSync } from './fsutil.mjs';

const pad = (n) => String(n).padStart(2, '0');
const date = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (d, sep) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join(sep);

/** First name that is free: `name`, then `name <stamp>`, then `name <stamp> 2`, ... */
function uniqueName(name, stamp, isTaken) {
  if (!isTaken(name)) return name;
  const base = `${name} ${stamp}`;
  let n = base;
  for (let i = 2; isTaken(n); i++) n = `${base} ${i}`;
  return n;
}

/**
 * Where `src` will land in the system Trash. Pure: touches nothing.
 * `taken` collects destinations already planned, so several folders with the same name get distinct slots.
 * Returns { dest, info? }; `info` is the .trashinfo file to write on Linux.
 */
export function trashTarget(src, { home, platform = process.platform, now = new Date(), taken = new Set() }) {
  const name = path.basename(src);
  if (platform === 'darwin') {
    const dir = path.join(home, '.Trash');
    const free = (n) => taken.has(path.join(dir, n)) || fs.existsSync(path.join(dir, n));
    const dest = path.join(dir, uniqueName(name, `${date(now)} ${time(now, '.')}`, free));
    taken.add(dest);
    return { dest };
  }
  if (platform === 'linux') {
    const root = path.join(home, '.local', 'share', 'Trash');
    const free = (n) =>
      taken.has(path.join(root, 'files', n)) ||
      fs.existsSync(path.join(root, 'files', n)) ||
      fs.existsSync(path.join(root, 'info', `${n}.trashinfo`));
    const unique = uniqueName(name, `${date(now)} ${time(now, '.')}`, free);
    const dest = path.join(root, 'files', unique);
    taken.add(dest);
    const original = path.resolve(src).split('/').map(encodeURIComponent).join('/');
    const body = `[Trash Info]\nPath=${original}\nDeletionDate=${date(now)}T${time(now, ':')}\n`;
    return { dest, info: { path: path.join(root, 'info', `${unique}.trashinfo`), body } };
  }
  throw new SkmError('unsupported', `moving to the system Trash is not supported on ${platform}; delete ${src} by hand`);
}

/** Move `src` to a destination from trashTarget. Cross-device moves work (copy + remove). */
export function trashSync(src, { dest, info }) {
  if (info) {
    fs.mkdirSync(path.dirname(info.path), { recursive: true });
    fs.writeFileSync(info.path, info.body);
  }
  moveSync(src, dest);
}
