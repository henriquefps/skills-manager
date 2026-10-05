/** Field weights shared by `skm projects find` and `GET /api/projects?q=`. */
const FIELDS = [
  [5, (p) => [p.name]],
  [4, (p) => p.meta?.tags ?? []],
  [3, (p) => [p.meta?.description]],
  [2, (p) => p.auto?.stack ?? []],
  [2, (p) => [p.meta?.notes]],
  [1, (p) => [p.auto?.readme]],
  [1, (p) => [p.auto?.remote]],
  [1, (p) => [p.root]],
];

/** Description shown for a project: the stored one, else the README line (auto). */
export const projectDescription = (p) => p.meta?.description || p.auto?.readme || '';

/** Effective status: a never-set status counts as `active`. */
export const projectStatus = (p) => p.meta?.status || 'active';

/** Score of one project for the query tokens (lowercase), or 0 unless every token matches somewhere. */
function score(p, tokens) {
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const [weight, values] of FIELDS) {
      if (weight > best && values(p).some((v) => typeof v === 'string' && v.toLowerCase().includes(t))) best = weight;
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

/**
 * Case-insensitive search: the query is split on whitespace and every token must match (substring) in some field.
 * Score = sum over tokens of the best field weight. Ties: most recent `auto.lastCommitAt`, then name.
 * An empty query keeps everything (same tie-break order).
 */
export function searchProjects(projects, query) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return projects
    .map((p) => ({ p, s: tokens.length ? score(p, tokens) : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.p.auto?.lastCommitAt ?? '').localeCompare(a.p.auto?.lastCommitAt ?? '') || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0))
    .map((x) => x.p);
}
