import fs from 'node:fs';
import path from 'node:path';
import { parseDescription } from './fsutil.mjs';

const TRIGGER = /\buse (this|it|when|whenever|for|to|me|if)\b|\bwhen (the user|a user|you|someone|asked|asking|working|writing|building|creating|editing|needed)\b|\btrigger|\binvoke|\bwhenever\b|\bactivate\b|\bload (this|when)\b/i;
const NAME_OK = /^[a-z0-9-]+$/;

/** Parse the `---` block at the top of a SKILL.md: { ok, name } (`ok` false when missing or unparseable). */
function frontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { ok: false };
  const lines = m[1].split(/\r?\n/);
  for (const l of lines) {
    if (!l.trim() || /^\s/.test(l) || l.startsWith('#')) continue;
    if (!/^[A-Za-z0-9_-]+\s*:/.test(l)) return { ok: false };
  }
  const n = lines.find((l) => /^name:/.test(l));
  const name = n ? n.replace(/^name:\s*/, '').trim().replace(/^(["'])(.*)\1$/, '$2') : '';
  return { ok: true, name };
}

/** Relative references SKILL.md makes to files in its own folder (markdown links and references/scripts/assets paths). */
function references(md) {
  const refs = new Set();
  const add = (raw) => {
    const p = raw.split(/[#?]/)[0].replace(/^\.\//, '').replace(/[.,;:!)]+$/, '');
    if (!p || /^([a-z][a-z0-9+.-]*:|\/|~|#)/i.test(p) || /[<>*{}$|\s]/.test(p)) return;
    refs.add(p);
  };
  for (const m of md.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) add(m[1]);
  for (const m of md.matchAll(/(?<![\w./-])((?:references|scripts|assets)\/[\w./-]+)/g)) add(m[1]);
  return [...refs];
}

/** Lint a skill folder: [{ rule, severity, message }], empty when clean. */
export function lintSkill(dir, folderName) {
  const out = [];
  const add = (rule, severity, message) => out.push({ rule, severity, message });
  let md;
  try {
    md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    add('no-skill-md', 'error', 'folder has no SKILL.md');
    return out;
  }
  const fm = frontmatter(md);
  if (!fm.ok) add('bad-frontmatter', 'error', 'SKILL.md has no valid --- frontmatter block');
  else {
    const desc = parseDescription(md);
    if (!fm.name) add('missing-name', 'error', 'frontmatter has no name');
    else {
      if (fm.name !== folderName) add('name-mismatch', 'warn', `frontmatter name "${fm.name}" differs from the folder name "${folderName}"`);
      if (!NAME_OK.test(fm.name) || fm.name.length > 64) add('name-invalid', 'warn', `name "${fm.name}" should be lowercase letters, digits and hyphens, at most 64 characters`);
    }
    if (!desc) add('missing-description', 'error', 'frontmatter has no description');
    else {
      if (desc.length > 1024) add('description-long', 'warn', `description is ${desc.length} characters (over 1024)`);
      if (desc.length < 40) add('description-short', 'warn', `description is only ${desc.length} characters (under 40)`);
      if (!TRIGGER.test(desc)) add('no-trigger-hint', 'info', 'description never says when to use the skill');
    }
  }
  for (const ref of references(md)) {
    if (!fs.existsSync(path.join(dir, ref))) add('broken-reference', 'warn', `SKILL.md refers to ${ref}, which does not exist in the folder`);
  }
  const lines = md.split('\n').length - (md.endsWith('\n') ? 1 : 0);
  if (lines > 500) add('skill-md-large', 'info', `SKILL.md has ${lines} lines (over 500)`);
  return out;
}
