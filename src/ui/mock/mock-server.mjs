// Tiny stand-in for src/server.mjs: serves src/ui and a fake in-memory /api/*.
// Usage: node src/ui/mock/mock-server.mjs   (PORT=4748, MOCK_NO_PROJECT=1 for a project-less cwd,
// MOCK_ROOTS=1 to start with scan roots configured)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4748);
const HOME = '/Users/demo';
const ROOT = '/Users/demo/code/atlas';
const noProject = !!process.env.MOCK_NO_PROJECT;

const loc = (root, path, kind = 'dir', target) => ({ root, path, kind, ...(target ? { target } : {}) });
const gAgents = (n) => loc('agents', `${HOME}/.agents/skills/${n}`);
const gLink = (n) => loc('claude', `${HOME}/.claude/skills/${n}`, 'symlink', `../../.agents/skills/${n}`);

function mk(scope, name, status, description, extra = {}) {
  return {
    name, scope, active: true, status, issues: [], description,
    files: 3, bytes: 8200 + name.length * 311, mtime: '2026-09-28T10:00:00.000Z',
    locations: [], alsoIn: [], ...extra,
  };
}

// Same estimate as the contract: Math.ceil(chars / 4).
const costOf = (s) => ({
  listing: Math.ceil((s.name.length + (s.description || '').length) / 4),
  full: s.files === 0 ? 0 : Math.ceil(s.bytes / 4),
});
const TRIGGER = /use when|use this|use for|use to|when |whenever|trigger|can use/i;
const LINT_EXTRA = {
  'capacitor-app-checklist': [
    { rule: 'name-mismatch', severity: 'warn', message: 'Frontmatter name "capacitor-checklist" does not match the folder name "capacitor-app-checklist".' },
    { rule: 'broken-reference', severity: 'warn', message: 'references/android.md is mentioned in SKILL.md but does not exist.' }],
  'build-a-saas': [{ rule: 'skill-md-large', severity: 'info', message: 'SKILL.md has 812 lines (over 500). Consider moving detail into references/.' }],
  'cordova-plugins': [{ rule: 'description-long', severity: 'warn', message: 'Description is 1180 characters (over 1024).' }],
  'log-session': [{ rule: 'name-invalid', severity: 'warn', message: 'Name "Log_Session" should use lowercase letters, digits and hyphens only.' }],
};
function lintOf(s) {
  const out = [];
  if (s.files === 0) out.push({ rule: 'no-skill-md', severity: 'error', message: 'Folder has no SKILL.md.' });
  else {
    if (!s.description) out.push({ rule: 'missing-description', severity: 'error', message: 'Frontmatter has no description.' });
    else {
      if (s.description.length < 40) out.push({ rule: 'description-short', severity: 'warn', message: `Description is only ${s.description.length} characters. Say what it does and when to use it.` });
      if (!TRIGGER.test(s.description)) out.push({ rule: 'no-trigger-hint', severity: 'info', message: 'Description never says when to use the skill (for example "Use when ...").' });
    }
  }
  return [...out, ...(LINT_EXTRA[s.name] || [])];
}
const decorate = (s) => Object.assign(s, { cost: costOf(s), lint: lintOf(s) });

let db = { global: [], local: [] };
const remote = {}; // what the fake GitHub says about each tracked skill
function seed() {
  const g = [
    mk('global', 'orca-cli', 'ok', 'Operate Orca-managed worktrees, terminals and the embedded browser from the public orca CLI.', { locations: [gAgents('orca-cli'), gLink('orca-cli')], files: 6, bytes: 24800 }),
    mk('global', 'hfps-visuals', 'ok', 'Create visual content in the hfps identity: flow diagrams, comparison tables and figures exported to 2x PNG.', { locations: [gAgents('hfps-visuals'), gLink('hfps-visuals')], files: 9 }),
    mk('global', 'wrangler', 'ok', 'Cloudflare Workers CLI for deploying, developing and managing Workers, KV, R2 and D1.', { locations: [gAgents('wrangler'), gLink('wrangler')] }),
    mk('global', 'log-session', 'ok', 'Append a durable, evidence-based record of the current work session to sessions/session.md.', { locations: [gAgents('log-session'), gLink('log-session')], files: 1 }),
    mk('global', 'adr-logger', 'ok', 'Document and log architectural decisions automatically whenever a design decision is made.', { active: false, locations: [loc('agents', `${HOME}/.agents/skills-inactive/adr-logger`)] }),
    mk('global', 'audit-codebase', 'needs-link', 'Perform a thorough, evidence-based code review and write findings into a code_review folder.', { issues: ['Missing entry in ~/.claude/skills'], locations: [gAgents('audit-codebase')] }),
    mk('global', 'linear-workflow', 'duplicate', 'Structured workflow for project management on Linear: plan, implement, review and track issues.', { issues: ['Real folders in agents and claude with identical contents'], locations: [gAgents('linear-workflow'), loc('claude', `${HOME}/.claude/skills/linear-workflow`)] }),
    mk('global', 'capacitor-app-checklist', 'diverged', 'Checklist of recurring platform-level concerns for Capacitor mobile apps.', { issues: ['agents and claude copies differ (2 files changed)'], locations: [gAgents('capacitor-app-checklist'), loc('claude', `${HOME}/.claude/skills/capacitor-app-checklist`)] }),
    mk('global', 'cordova-plugins', 'claude-only', 'Guideline for building, optimizing and debugging hybrid mobile Cordova and Capacitor native plugins.', { issues: ['Only exists in ~/.claude/skills, not in the agents store'], locations: [loc('claude', `${HOME}/.claude/skills/cordova-plugins`)] }),
    mk('global', 'react-agent-builder', 'broken-link', '', { issues: ['Symlink target does not exist'], locations: [loc('claude', `${HOME}/.claude/skills/react-agent-builder`, 'broken-symlink', '../../.agents/skills/react-agent-builder')], files: 0, bytes: 0 }),
    mk('global', 'outsystems-ui-js', 'wrong-link', 'Create pure js components for outsystems apps.', { issues: ['Claude link points to ~/old-skills/outsystems-ui-js'], locations: [gAgents('outsystems-ui-js'), loc('claude', `${HOME}/.claude/skills/outsystems-ui-js`, 'symlink', '../../old-skills/outsystems-ui-js')] }),
    mk('global', 'scratch-notes', 'empty', '', { issues: ['Folder has no SKILL.md'], locations: [gAgents('scratch-notes'), gLink('scratch-notes')], files: 0, bytes: 0 }),
    mk('global', 'build-a-saas', 'conflict', 'Blueprint and execution guideline for planning and building a lightweight SaaS.', { issues: ['2 Syncthing conflict files: SKILL.sync-conflict-20260901.md'], locations: [gAgents('build-a-saas'), gLink('build-a-saas')], files: 5 }),
  ];
  const l = [
    mk('local', 'atlas-conventions', 'ok', 'Naming, folder layout and review rules for the Atlas monorepo.', { locations: [loc('claude', `${ROOT}/.claude/skills/atlas-conventions`)] }),
    mk('local', 'release-checklist', 'ok', 'Steps for cutting an Atlas release, from changelog to tag and deploy.', { locations: [loc('agents', `${ROOT}/.agents/skills/release-checklist`), loc('claude', `${ROOT}/.claude/skills/release-checklist`)] }),
    mk('local', 'wrangler', 'diverged', 'Cloudflare Workers CLI, pinned to the Atlas account setup.', { issues: ['Contents differ between agents and claude copies'], locations: [loc('agents', `${ROOT}/.agents/skills/wrangler`), loc('claude', `${ROOT}/.claude/skills/wrangler`)] }),
    mk('local', 'db-migrations', 'ok', 'Write and verify SQL migrations for the Atlas Postgres schema.', { active: false, locations: [loc('claude', `${ROOT}/.claude/skills-inactive/db-migrations`)] }),
    mk('local', 'half-written', 'empty', '', { issues: ['Folder has no SKILL.md'], locations: [loc('claude', `${ROOT}/.claude/skills/half-written`)], files: 0, bytes: 0 }),
  ];
  const org = (name, source, installedAt, modified = false, status = 'up-to-date', extra = {}) => {
    const sk = g.find((x) => x.name === name);
    sk.origin = { source, url: `https://github.com/${source}.git`, skillPath: `skills/${name}/SKILL.md`, installedAt, updatedAt: installedAt, modified };
    remote[name] = { status, ...extra };
  };
  for (const sk of g) sk.origin = null;
  for (const k of Object.keys(remote)) delete remote[k];
  org('orca-cli', 'stablyai/orca', '2026-09-12T09:30:00.000Z');
  org('wrangler', 'cloudflare/skills', '2026-07-02T14:10:00.000Z', false, 'update-available', { remoteHash: 'a41c9e0' });
  org('linear-workflow', 'linear/agent-skills', '2026-08-19T08:00:00.000Z', false, 'update-available', { remoteHash: '7be02d1' });
  org('build-a-saas', 'indie-kit/skills', '2026-06-23T02:43:28.718Z', true, 'update-available', { remoteHash: 'c0ffee3' });
  org('adr-logger', 'henriquefps/agent-skills', '2026-05-30T17:20:00.000Z', true);
  org('cordova-plugins', 'cordova-community/skills', '2026-04-11T11:00:00.000Z', false, 'removed-upstream');
  org('outsystems-ui-js', 'outsystems/agent-skills', '2026-08-02T10:15:00.000Z', false, 'unreachable', { error: 'GitHub rate limit exceeded (resets in 41 min)' });
  [...g, ...l].forEach(decorate);
  db = { global: g, local: noProject ? [] : l };
  seedProjects();
  link();
}
function link() {
  for (const s of ['global', 'local']) {
    const other = s === 'global' ? 'local' : 'global';
    for (const sk of db[s]) sk.alsoIn = db[other].some((o) => o.name === sk.name) ? [other] : [];
  }
}
// ---- projects and config (in memory) ----
let config = { projectRoots: process.env.MOCK_ROOTS ? ['~/code', '~/Documents'] : [], scanDepth: 3 };
const pdb = {}; // projectRoot -> Skill[] for every project but the current one (db.local)
const sameFolder = new Set(['release-notes']); // names whose copies are identical across projects
function seedProjects() {
  const at = (root, name, status, description, extra = {}) => decorate(mk('local', name, status, description, {
    locations: [loc('claude', `${root}/.claude/skills/${name}`)], ...extra }));
  const L = '/Users/demo/code/ledger';
  const P = '/Users/demo/code/pixel-site';
  const N = '/Users/demo/Documents/notes-api';
  pdb[L] = [
    at(L, 'release-notes', 'ok', 'Draft release notes from merged pull requests. Use when cutting a release.'),
    at(L, 'sql-style', 'ok', 'House style for SQL in the ledger schema. Use when writing or reviewing queries.', { bytes: 14600 }),
    at(L, 'wrangler', 'ok', 'Cloudflare Workers CLI, ledger flavored.'),
  ];
  pdb[P] = [
    at(P, 'release-notes', 'ok', 'Draft release notes from merged pull requests. Use when cutting a release.'),
    at(P, 'design-tokens', 'ok', 'Pixel site design tokens and how to apply them. Use when styling components.', { active: false, locations: [loc('claude', `${P}/.claude/skills-inactive/design-tokens`)] }),
    at(P, 'wrangler', 'ok', 'Cloudflare Workers CLI for the marketing site.'),
  ];
  pdb[N] = [
    at(N, 'release-notes', 'ok', 'Draft release notes from merged pull requests. Use when cutting a release.'),
    at(N, 'api-conventions', 'diverged', 'REST naming, pagination and error shape for notes-api. Use when adding an endpoint.', { issues: ['agents and claude copies differ'] }),
    at(N, 'atlas-conventions', 'ok', 'Naming, folder layout and review rules for the Atlas monorepo.'),
  ];
}
const catalog = () => [
  { root: ROOT, name: 'atlas', list: db.local },
  ...Object.entries(pdb).map(([root, list]) => ({ root, name: root.split('/').pop(), list })),
];
const expand = (p) => (p.startsWith('~') ? HOME + p.slice(1) : p);
const inRoots = (root) => config.projectRoots.some((r) => root.startsWith(expand(r) + '/'));
const visibleProjects = () => catalog().filter((p) => !noProject || p.root !== ROOT).filter((p) => inRoots(p.root));
const localList = (root) => (!root || root === ROOT ? db.local : pdb[root]);
function setLocalList(root, arr) { if (!root || root === ROOT) db.local = arr; else pdb[root] = arr; }

function projectsPayload() {
  const projects = visibleProjects().filter((p) => p.list.length).map((p) => ({
    root: p.root, name: p.name,
    skills: p.list.map((x) => ({ name: x.name, active: x.active, status: x.status, cost: x.cost, meta: metaOf(x.name) })),
  }));
  const byName = new Map();
  for (const p of projects) for (const k of p.skills) byName.set(k.name, [...(byName.get(k.name) || []), p.root]);
  const repeated = [...byName].filter(([, roots]) => roots.length > 1).map(([name, roots]) => ({
    name, projects: roots, inGlobal: db.global.some((g) => g.name === name), identical: sameFolder.has(name),
  }));
  return { roots: config.projectRoots.map(expand), projects, repeated };
}

seed();

// ---- favorites and tags (in memory, keyed by skill name like the real config) ----
const metaDb = {
  'orca-cli': { favorite: true, tags: ['agents', 'orca'] },
  'wrangler': { favorite: true, tags: ['cloudflare', 'saas'] },
  'adr-logger': { favorite: true, tags: ['docs'] },
  'build-a-saas': { favorite: false, tags: ['saas'] },
  'cordova-plugins': { favorite: false, tags: ['mobile'] },
  'capacitor-app-checklist': { favorite: false, tags: ['mobile'] },
  'hfps-visuals': { favorite: false, tags: ['design', 'docs'] },
  'release-notes': { favorite: true, tags: [] },
};
const metaSeed = JSON.stringify(metaDb);
const TAG_RE = /^[a-z0-9-]{1,24}$/;
const metaOf = (name) => { const e = metaDb[name]; return { favorite: !!(e && e.favorite), tags: e ? [...e.tags] : [] }; };
const withMeta = (list) => list.map((s) => ({ ...s, meta: metaOf(s.name) }));
const onDisk = () => new Set([...db.global, ...db.local].map((s) => s.name));
function metaSummary() {
  const names = onDisk();
  const counts = new Map();
  let favorites = 0;
  for (const n of names) {
    const m = metaOf(n);
    if (m.favorite) favorites += 1;
    for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const tags = [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { tags, favorites };
}
function applyMeta(b) {
  if (typeof b.name !== 'string' || !onDisk().has(b.name)) return err('not-found', `No skill named ${b.name}.`, 404);
  const cur = metaOf(b.name);
  const norm = (list, what) => {
    if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) return { error: `${what} must be an array of strings.` };
    for (const t of list) if (!TAG_RE.test(t)) return { error: `Invalid tag "${t}". Tags are lowercase letters, digits and hyphens, 1 to 24 characters.` };
    return { list };
  };
  let tags = cur.tags;
  for (const [field, what] of [['tags', 'tags'], ['addTags', 'addTags'], ['removeTags', 'removeTags']]) {
    if (b[field] === undefined) continue;
    const r = norm(b[field], what);
    if (r.error) return err('invalid', r.error, 400);
    if (field === 'tags') tags = r.list;
    else if (field === 'addTags') tags = [...tags, ...r.list];
    else tags = tags.filter((t) => !r.list.includes(t));
  }
  tags = [...new Set(tags)].sort();
  if (tags.length > 8) return err('invalid', 'A skill can have at most 8 tags.', 400);
  let favorite = cur.favorite;
  if (b.favorite !== undefined) {
    if (typeof b.favorite !== 'boolean') return err('invalid', 'favorite must be true or false.', 400);
    favorite = b.favorite;
  }
  if (!favorite && !tags.length) delete metaDb[b.name]; else metaDb[b.name] = { favorite, tags };
  return { body: { ok: true, meta: metaOf(b.name) } };
}

const find = (scope, name, root) => (scope === 'local' ? localList(root) : db[scope]).find((s) => s.name === name);
const err = (code, error, status = 409) => ({ status, body: { ok: false, error, code } });

function act(d, b) {
  let root = ROOT;
  if (b.projectRoot) {
    root = b.projectRoot;
    const known = root === ROOT || (visibleProjects().some((p) => p.root === root));
    if (!known) return err('bad-project', `${root} is not inside a configured scan root.`, 400);
    if (b.scope !== 'local') return err('bad-scope', 'projectRoot only applies to local skills.', 400);
  }
  const s = find(b.scope, b.name, b.projectRoot);
  if (!s) return err('not-found', b.scope === 'global' ? `no global skill: ${b.name}` : `No ${b.scope} skill named ${b.name}.`, 404);
  const g = b.scope === 'global';
  switch (b.action) {
    case 'activate':
    case 'deactivate': {
      const on = b.action === 'activate';
      if (s.active === on) return err('noop', `${b.name} is already ${on ? 'active' : 'inactive'}.`);
      const changes = [`move ${s.name} ${on ? 'from skills-inactive' : 'to skills-inactive'}`];
      if (g) changes.push(on ? `symlink ~/.claude/skills/${s.name} -> ../../.agents/skills/${s.name}` : `remove ~/.claude/skills/${s.name}`);
      if (!b.dryRun) s.active = on;
      return { body: { ok: true, message: `${on ? 'Activated' : 'Deactivated'} ${s.name}.`, changes } };
    }
    case 'normalize': {
      if (!g) return err('bad-scope', 'Normalize works on global skills only.', 400);
      if (s.status === 'ok') return { body: { ok: true, message: `${s.name} is already normalized.`, changes: [] } };
      if (s.status === 'diverged' && !b.keep) return err('diverged', `${s.name} has diverged copies. Choose keep: agents or claude.`);
      const p = `${HOME}/.claude/skills/${s.name}`;
      const a = `${HOME}/.agents/skills/${s.name}`;
      const map = {
        'needs-link': [`symlink ${p} -> ../../.agents/skills/${s.name}`],
        'duplicate': [`remove ${p} (identical copy)`, `symlink ${p} -> ../../.agents/skills/${s.name}`],
        'claude-only': [`move ${p} -> ${a}`, `symlink ${p} -> ../../.agents/skills/${s.name}`],
        'wrong-link': [`remove link ${p}`, `symlink ${p} -> ../../.agents/skills/${s.name}`],
        'broken-link': [`remove dangling link ${p}`],
        'diverged': b.keep === 'claude'
          ? [`replace ${a} with ${p}`, `symlink ${p} -> ../../.agents/skills/${s.name}`]
          : [`remove ${p} (keeping agents)`, `symlink ${p} -> ../../.agents/skills/${s.name}`],
      };
      const changes = map[s.status];
      if (!changes) return err('not-fixable', `${s.name} (${s.status}) cannot be normalized automatically.`, 422);
      if (!b.dryRun) {
        Object.assign(s, { status: s.status === 'broken-link' ? 'empty' : 'ok', issues: [], locations: [gAgents(s.name), gLink(s.name)] });
        if (s.status === 'empty') s.issues = ['Folder has no SKILL.md'];
      }
      return { body: { ok: true, message: `Normalized ${s.name}.`, changes } };
    }
    case 'promote': {
      if (g) return err('bad-scope', 'Promote works on local skills only.', 400);
      const ex = find('global', s.name);
      if (ex && !b.overwrite) return err('exists', `A global skill named ${s.name} already exists. Enable overwrite to replace it.`);
      const changes = [`copy ${s.locations[0].path} -> ${HOME}/.agents/skills/${s.name}`, `symlink ${HOME}/.claude/skills/${s.name} -> ../../.agents/skills/${s.name}`];
      if (!b.dryRun) {
        db.global = db.global.filter((x) => x.name !== s.name);
        db.global.push({ ...s, scope: 'global', status: 'ok', issues: [], locations: [gAgents(s.name), gLink(s.name)] });
        link();
      }
      return { body: { ok: true, message: `Promoted ${s.name} to global.`, changes } };
    }
    case 'copyToLocal': {
      if (!g) return err('bad-scope', 'Copy to local works on global skills only.', 400);
      if (noProject && !b.projectRoot) return err('no-project', 'No project detected for this folder.', 400);
      const ex = find('local', s.name, b.projectRoot);
      if (ex && !b.overwrite) return err('exists', `A local skill named ${s.name} already exists. Enable overwrite to replace it.`);
      const tgt = b.target === 'agents' ? 'agents' : 'claude';
      const path = `${root}/.${tgt}/skills/${s.name}`;
      if (!b.dryRun) {
        setLocalList(b.projectRoot, localList(b.projectRoot).filter((x) => x.name !== s.name));
        localList(b.projectRoot).push({ ...s, scope: 'local', active: true, status: 'ok', issues: [], locations: [loc(tgt, path)] });
        link();
      }
      return { body: { ok: true, message: `Copied ${s.name} to ${path.replace(root, '.')}.`, changes: [`copy ${s.locations[0].path} -> ${path}`] } };
    }
    case 'update': {
      if (!g) return err('bad-scope', 'Update works on global skills only.', 400);
      if (!s.origin) return err('not-tracked', `${s.name} has no recorded source, so it cannot be updated.`, 422);
      const r = remote[s.name] || { status: 'up-to-date' };
      if (r.status === 'removed-upstream') return err('removed-upstream', `${s.name} no longer exists in ${s.origin.source}.`, 422);
      if (r.status === 'unreachable') return err('network', `Could not reach ${s.origin.source}: ${r.error}.`, 502);
      if (s.origin.modified && !b.force) return err('modified', `${s.name} has local changes. Update again with force to replace them.`);
      const changes = [`clone ${s.origin.url} (depth 1)`, `trash ${s.locations[0].path} -> ${HOME}/.Trash/${s.name}`,
        `copy skills/${s.name} -> ${s.locations[0].path}`, `update ~/.agents/.skill-lock.json entry for ${s.name}`];
      if (!b.dryRun) {
        const now = new Date().toISOString();
        s.origin = { ...s.origin, updatedAt: now, modified: false };
        remote[s.name] = { status: 'up-to-date' };
      }
      return { body: { ok: true, message: `Updated ${s.name} from ${s.origin.source}. The old version is in the system Trash.`, changes } };
    }
    case 'delete': {
      const changes = [`trash ${s.locations[0].path} -> ${HOME}/.Trash/${s.name}`];
      if (g) changes.push(`remove ${HOME}/.claude/skills/${s.name}`);
      if (!b.dryRun) {
        if (g) db.global = db.global.filter((x) => x !== s); else setLocalList(b.projectRoot, localList(b.projectRoot).filter((x) => x !== s));
        link();
      }
      return { body: { ok: true, message: `Moved ${s.scope}/${s.name} to the system Trash (${HOME}/.Trash/${s.name}).`, changes } };
    }
    default:
      return err('bad-action', `Unknown action ${b.action}.`, 400);
  }
}

// ---- /api/diff ----
const H = (oldStart, oldLines, newStart, newLines, lines) => ({ oldStart, oldLines, newStart, newLines, lines });
function diffFor(name) {
  const f = [];
  const count = (c) => f.reduce((n, x) => n + x.hunks.reduce((m, h) => m + h.lines.filter((l) => l[0] === c).length, 0), 0);
  if (name === 'wrangler') {
    f.push({ path: 'SKILL.md', status: 'modified', binary: false, hunks: [
      H(3, 6, 3, 7, [' description: Cloudflare Workers CLI for deploying, developing and managing Workers,', '-KV, R2 and D1.', '+KV, R2, D1, Queues and Workflows.', ' ---', ' ', ' # Wrangler', ' ']),
      H(41, 6, 42, 9, [' ## Deploying', ' ', '-Run `wrangler deploy` from the project root.', '+Run `wrangler deploy` from the project root. Use `--dry-run` first to see the bundle size.', '+', '+Secrets are never read from the config file; use `wrangler secret put`.', ' ', ' ## Local development', ' ']),
    ] });
    f.push({ path: 'references/queues.md', status: 'added', binary: false, hunks: [H(0, 0, 1, 5, ['+# Queues', '+', '+Create a queue with `wrangler queues create <name>`.', '+Bind it as a producer or consumer in the config.', '+Messages are delivered at least once.'])] });
    f.push({ path: 'assets/diagram.png', status: 'added', binary: true, hunks: [] });
    f.push({ path: 'references/legacy-kv.md', status: 'removed', binary: false, hunks: [H(1, 3, 0, 0, ['-# Legacy KV', '-', '-Use the v1 namespace commands.'])] });
    return { name, from: '45cc198', to: '2dab137', stats: { added: 2, removed: 1, modified: 1, insertions: count('+'), deletions: count('-') }, files: f };
  }
  if (name === 'build-a-saas') {
    f.push({ path: 'SKILL.md', status: 'modified', binary: false, hunks: [
      H(18, 8, 18, 7, [' ## Phase 1: Plan', ' ', '-NOTE (mine): always start with the pricing page copy.', ' Write the product brief before any code.', ' ', ' ## Phase 2: Build', ' ']),
      H(70, 5, 69, 6, [' ## Billing', ' ', '+Use Stripe Checkout for the first release; add the customer portal later.', ' Webhooks must be idempotent.', ' ']),
    ] });
    return { name, from: 'c01d00a', to: 'c0ffee3', stats: { added: 0, removed: 0, modified: 1, insertions: count('+'), deletions: count('-') }, files: f };
  }
  f.push({ path: 'SKILL.md', status: 'modified', binary: false, hunks: [H(5, 4, 5, 5, [' ## Usage', ' ', '-Run the workflow.', '+Run the workflow, then verify the result.', '+Report anything unexpected.'])] });
  return { name, from: '1a2b3c4', to: '5d6e7f8', stats: { added: 0, removed: 0, modified: 1, insertions: count('+'), deletions: count('-') }, files: f };
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state') {
      await new Promise((r) => setTimeout(r, 80));
      const tot = (list) => {
        const on = list.filter((x) => x.active);
        return { active: on.length, listingTokens: on.reduce((n, x) => n + x.cost.listing, 0) };
      };
      const totals = { global: tot(db.global), local: tot(db.local) };
      totals.listingTokens = totals.global.listingTokens + totals.local.listingTokens;
      return send(res, 200, {
        cwd: noProject ? HOME : `${ROOT}/packages/web`,
        project: noProject ? null : { root: ROOT, name: 'atlas' },
        global: withMeta(db.global), local: withMeta(db.local), totals, ...metaSummary(),
      });
    }
    if (url.pathname === '/api/diff') {
      await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DIFF_MS || 600)));
      const s = find('global', url.searchParams.get('name'));
      if (!s) return send(res, 404, { ok: false, error: 'Skill not found.', code: 'not-found' });
      if (!s.origin) return send(res, 422, { ok: false, error: `${s.name} has no recorded source.`, code: 'not-tracked' });
      const r = remote[s.name] || { status: 'up-to-date' };
      if (r.status === 'removed-upstream') return send(res, 422, { ok: false, error: `${s.name} no longer exists in ${s.origin.source}.`, code: 'removed-upstream' });
      if (r.status === 'unreachable' || process.env.MOCK_DIFF_FAIL) return send(res, 502, { ok: false, error: `Could not reach ${s.origin.source}.`, code: 'network' });
      return send(res, 200, diffFor(s.name));
    }
    if (url.pathname === '/api/config') {
      if (req.method === 'PUT') {
        let raw = '';
        for await (const c of req) raw += c;
        const b = JSON.parse(raw || '{}');
        if (!Array.isArray(b.projectRoots) || !b.projectRoots.every((r) => typeof r === 'string')) return send(res, 400, { ok: false, error: 'projectRoots must be an array of folder paths.', code: 'bad-config' });
        const bad = b.projectRoots.find((r) => !/^(~|\/)/.test(r) || /missing|nope/.test(r));
        if (bad) return send(res, 400, { ok: false, error: `${bad} is not an existing folder.`, code: 'bad-config' });
        if (!Number.isInteger(b.scanDepth) || b.scanDepth < 1 || b.scanDepth > 6) return send(res, 400, { ok: false, error: 'scanDepth must be a whole number from 1 to 6.', code: 'bad-config' });
        config = { projectRoots: [...new Set(b.projectRoots.map((r) => r.replace(/\/+$/, '')))], scanDepth: b.scanDepth };
      }
      return send(res, 200, config);
    }
    if (url.pathname === '/api/projects') {
      await new Promise((r) => setTimeout(r, 400));
      return send(res, 200, projectsPayload());
    }
    if (url.pathname === '/api/updates') {
      await new Promise((r) => setTimeout(r, Number(process.env.MOCK_CHECK_MS || 1200)));
      if (process.env.MOCK_CHECK_FAIL) return send(res, 502, { ok: false, error: 'Could not reach GitHub.', code: 'network' });
      const results = {};
      for (const sk of db.global) if (sk.origin) results[sk.name] = remote[sk.name] || { status: 'up-to-date' };
      return send(res, 200, { checkedAt: new Date().toISOString(), results });
    }
    if (url.pathname === '/api/skill') {
      const s = find(url.searchParams.get('scope'), url.searchParams.get('name'));
      if (!s) return send(res, 404, { ok: false, error: 'Skill not found.', code: 'not-found' });
      const markdown = s.files === 0 ? '' : `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\nUse this skill when the task matches its description.\n\n## Steps\n\n1. Read the references first.\n2. Apply the checklist.\n3. Report what changed.\n`;
      const tree = s.files === 0 ? [] : ['SKILL.md', 'references/guide.md', 'assets/template.html'].slice(0, Math.max(1, s.files));
      return send(res, 200, { skill: { ...s, meta: metaOf(s.name) }, markdown, tree });
    }
    if (url.pathname === '/api/_reset' && req.method === 'POST') {
      // Test hook for the mock only: back to the seed data (used by screenshot runs).
      seed();
      for (const k of Object.keys(metaDb)) delete metaDb[k];
      Object.assign(metaDb, JSON.parse(metaSeed));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/meta' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const out = applyMeta(JSON.parse(raw || '{}'));
      return send(res, out.status || 200, out.body);
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      if (Array.isArray(body.names)) {
        // Batch: continue past failures; top-level ok only if every item succeeded.
        const results = [];
        const changes = [];
        let message = '';
        for (const name of body.names) {
          const one = act(null, { ...body, names: undefined, name });
          const o = one.body;
          if (o.ok) { results.push({ name, ok: true }); changes.push(...(o.changes || [])); } else results.push({ name, ok: false, error: o.error, code: o.code });
        }
        const okN = results.filter((r) => r.ok).length;
        const all = okN === results.length;
        message = all ? `${body.dryRun ? 'Would copy' : 'Copied'} ${okN} ${okN === 1 ? 'skill' : 'skills'}.` : `${okN} of ${results.length} succeeded, ${results.length - okN} failed.`;
        return send(res, all ? 200 : 409, { ok: all, message, changes, results });
      }
      const out = act(null, body);
      return send(res, out.status || 200, out.body);
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'Unknown endpoint.', code: 'not-found' });

    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(UI, rel);
    if (!file.startsWith(UI) || rel.startsWith('/mock')) { res.writeHead(404); return res.end('Not found'); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    send(res, 500, { ok: false, error: String(e.message || e), code: 'internal' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`skm mock on http://127.0.0.1:${PORT}`));
