import { resolveContext, SkmError } from './context.mjs';
import { readProfiles } from './profiles.mjs';
import { scanProjects } from './projects.mjs';
import { compareWithGlobal, scanScope } from './scan.mjs';

/**
 * Health check: broken/orphan skills and same-name duplicates, each finding with the fixes that apply.
 * Errors: links pointing at nothing, active skills whose source is missing. Hints: forgotten inactive folders,
 * same name with diverged content. Fixes are plain POST /api/action requests (dry-run first, Trash instead of delete).
 */

export const HEALTH_SCOPES = ['global', 'local', 'projects'];
/** An inactive folder untouched for this long, and referenced by nothing, counts as forgotten. */
export const OLD_DAYS = 180;
const DAY = 86400000;

const brokenLinks = (s) => s.locations.filter((l) => l.kind === 'broken-symlink');
const linkText = (l) => `${l.path} -> ${l.target}`;
const noSkillMd = (s) => s.lint.some((f) => f.rule === 'no-skill-md');

/** Names something refers to: a profile, a favorite or tag, a lock entry (provenance). */
function referenced(s, profiled) {
  return profiled.has(s.name) || s.meta.favorite || s.meta.tags.length > 0 || Boolean(s.origin);
}

/** Findings for one skill. `where` = { project: { root, name } | null }. */
function skillFindings(s, where, { profiled, now }) {
  const out = [];
  const project = where.project;
  const req = (action, extra = {}) => ({ action, scope: s.scope, name: s.name, ...(project ? { projectRoot: project.root } : {}), ...extra });
  const finding = (type, severity, message, more = {}) => ({
    id: [type, more.kind ?? '', s.scope, project?.root ?? '', s.name].join(':'),
    type,
    severity,
    scope: s.scope,
    name: s.name,
    project,
    message,
    paths: [],
    fixes: [],
    manual: null,
    ...more,
  });
  const broken = brokenLinks(s);
  const working = s.locations.filter((l) => l.kind !== 'broken-symlink');
  const activeWorking = working.filter((l) => !l.inactive);
  const deleteFix = (label = 'Delete') => ({ label, request: req('delete') });

  if (s.active && !activeWorking.length) {
    // Every active entry is a link to nothing: the agent lists a skill it cannot load.
    out.push(finding('missing-source', 'error', `active, but its source is missing: ${broken.map(linkText).join(', ')}`, {
      kind: 'link',
      paths: broken.map((l) => l.path),
      fixes: [deleteFix(working.length ? 'Delete (the inactive copy goes to the Trash too)' : 'Remove the link')],
      manual: working.length ? `or remove the broken link by hand and activate the inactive copy: rm ${broken.map((l) => JSON.stringify(l.path)).join(' ')}` : null,
    }));
  } else {
    if (s.active && noSkillMd(s)) {
      out.push(finding('missing-source', 'error', 'active, but its folder has no SKILL.md', {
        kind: 'skill-md',
        paths: activeWorking.map((l) => l.path),
        fixes: [deleteFix('Delete')],
        manual: 'or add a SKILL.md to the folder',
      }));
    }
    if (broken.length) {
      const fixes = [];
      let manual = null;
      const onlyClaude = broken.length === 1 && broken[0].root === 'claude' && !broken[0].inactive;
      if (s.scope === 'global' && onlyClaude && s.locations.some((l) => l.root === 'agents' && !l.inactive && l.kind === 'dir')) {
        fixes.push({ label: 'Relink to the agents folder', request: req('normalize') });
      } else if (!working.length) fixes.push(deleteFix('Remove the link'));
      else manual = `remove the broken link by hand: rm ${broken.map((l) => JSON.stringify(l.path)).join(' ')}`;
      out.push(finding('broken-link', 'error', `link points at nothing: ${broken.map(linkText).join(', ')}`, { paths: broken.map((l) => l.path), fixes, manual }));
    }
  }

  if (!s.active && working.length) {
    const empty = s.files === 0 || noSkillMd(s);
    const old = s.mtime && now - new Date(s.mtime).getTime() > OLD_DAYS * DAY;
    const unref = !referenced(s, profiled);
    if (empty || (old && unref)) {
      const reasons = [empty && 'empty', unref && 'unreferenced', old && 'old'].filter(Boolean);
      const why = { empty: s.files === 0 ? 'empty' : 'no SKILL.md', unreferenced: 'no profile, favorite, tag or source refers to it', old: `unchanged for ${Math.floor((now - new Date(s.mtime).getTime()) / DAY)} days` };
      out.push(finding('forgotten-inactive', 'hint', `inactive folder looks forgotten: ${reasons.map((r) => why[r]).join('; ')}`, {
        reasons,
        paths: working.map((l) => l.path),
        fixes: [...(empty ? [] : [{ label: 'Activate', request: req('activate') }]), deleteFix('Delete')],
      }));
    }
  }

  if (s.status === 'diverged') {
    const fixes = s.scope === 'global'
      ? [{ label: 'Keep the agents copy', request: req('normalize', { keep: 'agents' }) }, { label: 'Keep the claude copy', request: req('normalize', { keep: 'claude' }) }]
      : [];
    out.push(finding('diverged', 'hint', `copies in ${s.scope === 'global' ? '~/.agents/skills and ~/.claude/skills' : '.agents/skills and .claude/skills'} have different content`, {
      kind: 'copies',
      paths: working.filter((l) => l.kind === 'dir').map((l) => l.path),
      fixes,
      manual: fixes.length ? null : 'keep one copy: compare both folders and remove the other one',
    }));
  }
  if (s.vsGlobal === 'diverged') {
    out.push(finding('diverged', 'hint', 'differs from the global skill of the same name', {
      kind: 'vs-global',
      paths: working.filter((l) => l.kind === 'dir').map((l) => l.path),
      fixes: [
        { label: 'Update local from global', request: req('refresh') },
        { label: 'Keep local: promote over global', request: req('promote', { overwrite: true }) },
      ],
    }));
  }
  return out;
}

/** Local skills of one project with `vsGlobal` (same data as /api/state and /api/projects). */
function localSkills(pctx, cache) {
  return scanScope(pctx, 'local').map((s) => ({ ...s, vsGlobal: compareWithGlobal(pctx, s.name, cache) }));
}

const ORDER = { error: 0, hint: 1 };
const sortKey = (f) => [ORDER[f.severity], f.scope === 'global' ? 0 : 1, f.project?.root ?? '', f.name, f.type];
const compare = (a, b) => {
  const x = sortKey(a);
  const y = sortKey(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

/**
 * Run the check. `scope`: undefined = global + the current project, `global`, `local` (current project only),
 * `projects` (global + every scanned project and the current one). Returns
 * `{ scope, checked: { global, projects: [{ root, name }] }, findings, counts: { error, hint } }`.
 */
export async function checkHealth(opts = {}, { scope } = {}) {
  const ctx = resolveContext(opts);
  if (scope !== undefined && !HEALTH_SCOPES.includes(scope)) throw new SkmError('invalid', `invalid scope: ${scope} (global, local or projects)`);
  if (scope === 'local' && !ctx.project) throw new SkmError('no-project', 'no project detected from the current directory');
  const now = (ctx.now ?? new Date()).getTime();
  const refs = { profiled: new Set(readProfiles(ctx).flatMap((p) => p.skills)), now };
  const findings = [];
  const checked = { global: scope !== 'local', projects: [] };
  if (checked.global) for (const s of scanScope(ctx, 'global')) findings.push(...skillFindings(s, { project: null }, refs));

  const cache = new Map();
  const projects = [];
  if (ctx.project && scope !== 'global') projects.push(ctx);
  let scan = null;
  if (scope === 'projects') {
    scan = await scanProjects(ctx);
    for (const p of scan.projects) {
      if (p.root === ctx.project?.root) continue;
      projects.push(resolveContext({ ...ctx, resolved: false, cwd: p.root, projectRoot: p.root }));
    }
  }
  for (const pctx of projects) {
    checked.projects.push({ ...pctx.project });
    for (const s of localSkills(pctx, cache)) findings.push(...skillFindings(s, { project: { ...pctx.project } }, refs));
  }

  // Same name in several projects with different content and no global copy to align them with.
  for (const r of scan?.repeated ?? []) {
    if (r.identical || r.inGlobal) continue;
    findings.push({
      id: `diverged:across-projects:local::${r.name}`,
      type: 'diverged',
      kind: 'across-projects',
      severity: 'hint',
      scope: 'local',
      name: r.name,
      project: null,
      message: `different copies in ${r.projects.length} projects and none in global`,
      paths: r.projects,
      fixes: [],
      manual: `promote the copy to keep (cd <project> && skm promote ${r.name}), then update the others from global`,
    });
  }
  findings.sort(compare);
  const counts = { error: findings.filter((f) => f.severity === 'error').length, hint: findings.filter((f) => f.severity === 'hint').length };
  return { scope: scope ?? null, checked, findings, counts };
}
