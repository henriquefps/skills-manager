// Tiny stand-in for src/server.mjs: serves src/ui and a fake in-memory /api/*.
// Usage: node src/ui/mock/mock-server.mjs   (PORT=4748, MOCK_NO_PROJECT=1 for a project-less cwd)
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

let db = { global: [], local: [] };
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
  db = { global: g, local: noProject ? [] : l };
  link();
}
function link() {
  for (const s of ['global', 'local']) {
    const other = s === 'global' ? 'local' : 'global';
    for (const sk of db[s]) sk.alsoIn = db[other].some((o) => o.name === sk.name) ? [other] : [];
  }
}
seed();

const find = (scope, name) => db[scope].find((s) => s.name === name);
const err = (code, error, status = 409) => ({ status, body: { ok: false, error, code } });

function act(d, b) {
  const s = find(b.scope, b.name);
  if (!s) return err('not-found', `No ${b.scope} skill named ${b.name}.`, 404);
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
      if (noProject) return err('no-project', 'No project detected for this folder.', 400);
      const ex = find('local', s.name);
      if (ex && !b.overwrite) return err('exists', `A local skill named ${s.name} already exists. Enable overwrite to replace it.`);
      const tgt = b.target === 'agents' ? 'agents' : 'claude';
      const path = `${ROOT}/.${tgt}/skills/${s.name}`;
      if (!b.dryRun) {
        db.local = db.local.filter((x) => x.name !== s.name);
        db.local.push({ ...s, scope: 'local', status: 'ok', issues: [], locations: [loc(tgt, path)] });
        link();
      }
      return { body: { ok: true, message: `Copied ${s.name} to ${path.replace(ROOT, '.')}.`, changes: [`copy ${s.locations[0].path} -> ${path}`] } };
    }
    case 'delete': {
      const changes = [`trash ${s.locations[0].path} -> ${HOME}/.Trash/${s.name}`];
      if (g) changes.push(`remove ${HOME}/.claude/skills/${s.name}`);
      if (!b.dryRun) { db[b.scope] = db[b.scope].filter((x) => x !== s); link(); }
      return { body: { ok: true, message: `Moved ${s.scope}/${s.name} to the system Trash (${HOME}/.Trash/${s.name}).`, changes } };
    }
    default:
      return err('bad-action', `Unknown action ${b.action}.`, 400);
  }
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
      return send(res, 200, {
        cwd: noProject ? HOME : `${ROOT}/packages/web`,
        project: noProject ? null : { root: ROOT, name: 'atlas' },
        global: db.global, local: db.local,
      });
    }
    if (url.pathname === '/api/skill') {
      const s = find(url.searchParams.get('scope'), url.searchParams.get('name'));
      if (!s) return send(res, 404, { ok: false, error: 'Skill not found.', code: 'not-found' });
      const markdown = s.files === 0 ? '' : `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\nUse this skill when the task matches its description.\n\n## Steps\n\n1. Read the references first.\n2. Apply the checklist.\n3. Report what changed.\n`;
      const tree = s.files === 0 ? [] : ['SKILL.md', 'references/guide.md', 'assets/template.html'].slice(0, Math.max(1, s.files));
      return send(res, 200, { skill: s, markdown, tree });
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const out = act(null, JSON.parse(raw || '{}'));
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
