import fs from 'node:fs';
import path from 'node:path';

export const INACTIVE_IGNORE = 'skills-inactive/';

/**
 * Plan an append of `skills-inactive/` to `<root>/.gitignore`.
 * Returns an op, or null when there is nothing to do: not a git project, no .gitignore
 * (never created), not writable, or an active line already mentions skills-inactive.
 */
export function inactiveIgnoreOp(root) {
  const file = path.join(root, '.gitignore');
  try {
    if (!fs.existsSync(path.join(root, '.git'))) return null;
    if (!fs.statSync(file).isFile()) return null;
    fs.accessSync(file, fs.constants.W_OK);
    const text = fs.readFileSync(file, 'utf8');
    const mentioned = text.split(/\r?\n/).some((l) => {
      const t = l.trim();
      return t && !t.startsWith('#') && t.includes('skills-inactive');
    });
    if (mentioned) return null;
    return { op: 'gitignore', path: file, line: INACTIVE_IGNORE, lead: text.length > 0 && !text.endsWith('\n') };
  } catch {
    return null;
  }
}

/** Apply the op; a failure here must never fail the deactivate. */
export function applyIgnoreOp(op) {
  try {
    fs.appendFileSync(op.path, `${op.lead ? '\n' : ''}${op.line}\n`);
  } catch { /* skip silently */ }
}
