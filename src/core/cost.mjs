import { parseDescription } from './fsutil.mjs';

/** Rough token estimate (chars / 4). An approximation, never exact. */
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);

function frontmatterName(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = m?.[1].split(/\r?\n/).find((l) => /^name:/.test(l));
  return line ? line.replace(/^name:\s*/, '').trim().replace(/^(["'])(.*)\1$/, '$2') : '';
}

/**
 * Context cost of a skill: `listing` is what every session loads (name + description),
 * `full` is the whole SKILL.md, loaded when the skill is invoked.
 */
export function costOf(md, fallbackName = '') {
  const name = frontmatterName(md) || fallbackName;
  return { listing: estimateTokens(`${name} ${parseDescription(md)}`), full: estimateTokens(md) };
}

/** Totals over active skills only (inactive ones cost nothing). Each skill is one name per scope: counted once. */
export function totalsOf(global, local) {
  const sum = (skills) => {
    const active = skills.filter((s) => s.active);
    return { active: active.length, listingTokens: active.reduce((n, s) => n + (s.cost?.listing ?? 0), 0) };
  };
  const g = sum(global);
  const l = sum(local);
  return { global: g, local: l, listingTokens: g.listingTokens + l.listingTokens };
}
