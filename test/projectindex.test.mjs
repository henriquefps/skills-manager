import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configPath, detectStack, lintSkill, mapLimit, normalizeRemote, projectAuto, readmeParagraph, readProjectMeta, scanProjects, searchProjects, updateProjectMeta, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { mkSkill, tmp, write } from './fixture.mjs';

const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });

/** A real temp git repo with one commit, one skill, and optionally an origin. */
function repo(dir, { remote, files = {}, branch = 'main', skills = ['s'] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', '-b', branch);
  for (const [f, c] of Object.entries(files)) write(path.join(dir, f), c);
  for (const s of skills) mkSkill(path.join(dir, '.claude', 'skills'), s);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) g(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

test('normalizeRemote: credentials and ports never survive, every form becomes host/owner/repo', () => {
  const cases = {
    'https://ghp_secretTOKEN123@github.com/me/app.git': 'github.com/me/app',
    'https://user:p%40ss@github.com/me/app': 'github.com/me/app',
    'https://x-access-token:abc@GitHub.com:443/me/app.git/': 'github.com/me/app',
    'git@github.com:me/app.git': 'github.com/me/app',
    'user:pw@gitlab.com:group/sub/app.git': 'gitlab.com/group/sub/app',
    'ssh://git@bitbucket.org:22/me/app.git': 'bitbucket.org/me/app',
    'git://github.com/me/app.git': 'github.com/me/app',
    'https://github.com/me/app.git?x=1#frag': 'github.com/me/app',
  };
  for (const [url, want] of Object.entries(cases)) {
    const got = normalizeRemote(url);
    assert.equal(got, want, url);
    assert.doesNotMatch(got, /@|token|secret|pw|:/i);
  }
  for (const bad of ['', '  ', null, undefined, '/local/path/repo', 'file:///tmp/repo', '../repo', 'nonsense']) assert.equal(normalizeRemote(bad), null, String(bad));
});

test('detectStack: one marker per tag, sorted and de-duplicated', () => {
  const stackOf = (files, dirs = []) => {
    const d = tmp();
    for (const [f, c] of Object.entries(files)) write(path.join(d, f), c);
    for (const x of dirs) fs.mkdirSync(path.join(d, x));
    return detectStack(d);
  };
  assert.deepEqual(stackOf({}), []);
  assert.deepEqual(stackOf({ 'package.json': '{not json' }), ['node']);
  const pkg = (deps, dev) => JSON.stringify({ dependencies: deps, devDependencies: dev });
  assert.deepEqual(
    stackOf({ 'package.json': pkg({ react: '1', express: '1', '@capacitor/core': '1', 'cordova-plugin-x': '1' }, { vite: '1', tailwindcss: '3', typescript: '5', svelte: '4', vue: '3', next: '14' }), 'components.json': '{}' }),
    ['capacitor', 'cordova', 'express', 'next', 'node', 'react', 'shadcn', 'svelte', 'tailwind', 'typescript', 'vite', 'vue'],
  );
  assert.deepEqual(stackOf({ 'pyproject.toml': '' }), ['python']);
  assert.deepEqual(stackOf({ 'requirements.txt': '', 'pyproject.toml': '' }), ['python']);
  assert.deepEqual(stackOf({ 'Cargo.toml': '' }), ['rust']);
  assert.deepEqual(stackOf({ 'go.mod': '' }), ['go']);
  assert.deepEqual(stackOf({ 'config.xml': '' }), ['cordova']);
  assert.deepEqual(stackOf({ 'plugin.xml': '', 'config.xml': '' }), ['cordova']);
  assert.deepEqual(stackOf({ 'App.csproj': '' }), ['dotnet']);
  assert.deepEqual(stackOf({ 'Package.swift': '' }), ['swift']);
  assert.deepEqual(stackOf({}, ['App.xcodeproj']), ['swift']);
  assert.deepEqual(stackOf({ 'build.gradle.kts': '' }), ['android']);
  assert.deepEqual(stackOf({ 'build.gradle': '' }), ['android']);
  assert.deepEqual(stackOf({ 'x.oml': '' }), ['outsystems']);
  assert.deepEqual(stackOf({ 'x.oap': '' }), ['outsystems']);
  assert.deepEqual(detectStack(path.join(tmp(), 'missing')), []);
});

test('readmeParagraph: skips headings, badges, images, html, code and tables; strips markdown; caps at 200', () => {
  const md = [
    '# Title',
    '',
    '[![CI](https://x/badge.svg)](https://x)  [![npm](https://y)](https://y)',
    '',
    '![logo](logo.png)',
    '<p align="center"><img src="a.png"></p>',
    '<!-- a',
    'multi line comment -->',
    '',
    '```sh',
    'npm install',
    '```',
    '',
    '| a | b |',
    '',
    'Setext heading',
    '==============',
    '',
    'A **bold** tool with a [link](https://z) and `code`',
    'that continues here.',
    '',
    'Second paragraph.',
  ].join('\n');
  assert.equal(readmeParagraph(md), 'A bold tool with a link and code that continues here.');
  assert.equal(readmeParagraph('# only a heading\n'), '');
  assert.equal(readmeParagraph(''), '');
  const long = readmeParagraph(`# t\n\n${'word '.repeat(100)}`);
  assert.ok(long.length <= 200 && long.endsWith('…'), String(long.length));
  assert.equal(readmeParagraph('Plain first line\r\nsecond\r\n'), 'Plain first line second');
});

test('projectAuto: real git repo (token remote, branch, last commit), readme, stack; failures leave fields absent', async () => {
  const dir = repo(path.join(tmp(), 'p'), { remote: 'https://ghp_TOPSECRET@github.com/me/p.git', files: { 'README.md': '# P\n\nDoes a thing.\n', 'package.json': '{"dependencies":{"react":"1"}}' }, branch: 'trunk' });
  const auto = await projectAuto({}, dir);
  assert.deepEqual(Object.keys(auto).sort(), ['branch', 'lastCommitAt', 'readme', 'remote', 'stack']);
  assert.equal(auto.remote, 'github.com/me/p');
  assert.equal(auto.branch, 'trunk');
  assert.match(auto.lastCommitAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.ok(Math.abs(Date.now() - Date.parse(auto.lastCommitAt)) < 60_000);
  assert.equal(auto.readme, 'Does a thing.');
  assert.deepEqual(auto.stack, ['node', 'react']);
  assert.doesNotMatch(JSON.stringify(auto), /TOPSECRET/);

  // no remote on a fresh repo: field absent
  const bare = repo(path.join(tmp(), 'bare'));
  assert.equal('remote' in (await projectAuto({}, bare)), false);

  // injected runner (sync or async): its answers are used; throwing leaves the field absent; detached HEAD has no branch
  const calls = [];
  const fake = (args, { cwd }) => {
    calls.push([args.join(' '), cwd]);
    if (args[0] === 'remote') return 'git@github.com:o/r.git\n';
    if (args[0] === 'rev-parse') return 'HEAD\n';
    throw new Error('boom');
  };
  const viaFake = await projectAuto({ git: fake }, bare);
  assert.deepEqual(viaFake, { remote: 'github.com/o/r', stack: [] });
  assert.equal(calls.length, 3);
  assert.deepEqual((await projectAuto({ git: async () => { throw new Error('x'); } }, bare)), { stack: [] });

  // a folder without its own .git never asks git (a parent repository must not leak in)
  const nested = path.join(bare, 'sub');
  fs.mkdirSync(nested);
  calls.length = 0;
  assert.deepEqual(await projectAuto({ git: fake }, nested), { stack: [] });
  assert.equal(calls.length, 0);
});

test('mapLimit: bounded concurrency, ordered results', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [10, 2, 8, 4, 6, 12, 14]);
  assert.ok(peak <= 3 && peak > 1, String(peak));
});

const P = (name, { tags = [], description = '', notes = '', stack = [], readme, remote, root, last } = {}) => ({
  root: root ?? `/w/${name}`,
  name,
  meta: { description, tags, status: '', notes },
  auto: { stack, ...(readme && { readme }), ...(remote && { remote }), ...(last && { lastCommitAt: last }) },
  skills: [],
});

test('search: AND semantics, case-insensitive, weights, tie-breaks', () => {
  const ps = [
    P('alpha', { description: 'sync plugin for mobile', tags: ['outsystems'], stack: ['cordova'] }),
    P('sync-tool', { readme: 'something else', last: '2026-01-01T00:00:00.000Z' }),
    P('beta', { tags: ['sync'], notes: 'no match' }),
    P('gamma', { readme: 'Plugin to SYNC things', remote: 'github.com/me/gamma', last: '2026-05-01T00:00:00.000Z' }),
    P('delta', { stack: ['react'], root: '/w/sync/delta' }),
  ];
  const names = (q) => searchProjects(ps, q).map((p) => p.name);
  // name 5 > tags 4 > description 3 > readme 1 == path 1 (tie: no commit dates on beta/delta... gamma and delta by date then name)
  assert.deepEqual(names('sync'), ['sync-tool', 'beta', 'alpha', 'gamma', 'delta']);
  assert.deepEqual(names('SYNC PLUGIN'), ['alpha', 'gamma']); // every token must match: alpha 3+3, gamma 1+1
  assert.deepEqual(names('sync   plugin  cordova'), ['alpha']);
  assert.deepEqual(names('sync nonexistentword'), []);
  assert.deepEqual(names('react'), ['delta']);
  assert.deepEqual(names('github.com/me'), ['gamma']); // remote
  assert.deepEqual(names('outsystems'), ['alpha']); // tags
  assert.deepEqual(names('no match'), ['beta']); // notes
});

const rawConfig = (home) => JSON.parse(fs.readFileSync(configPath(home), 'utf8'));

test('project meta: validation, trimming, sorted tags, pruning, every other key preserved', () => {
  const home = tmp();
  const ws = path.join(home, 'ws');
  const dir = repo(path.join(ws, 'app'));
  writeConfig({ home }, { projectRoots: [ws] });
  const raw = rawConfig(home);
  fs.writeFileSync(configPath(home), JSON.stringify({ ...raw, skills: { x: { favorite: true, tags: [] } }, unknown: { a: 1 } }));
  const set = (req) => updateProjectMeta({ home, cwd: home }, { root: dir, ...req });
  const bad = (req, code = 'invalid') => assert.throws(() => set(req), (e) => e.code === code, JSON.stringify(req).slice(0, 60));

  assert.deepEqual(set({ description: '  A thing  ', tags: ['Work', 'api', 'work'], status: 'paused', notes: 'n' }), { description: 'A thing', tags: ['api', 'work'], status: 'paused', notes: 'n' });
  const stored = rawConfig(home);
  assert.deepEqual(stored.projects[dir], { description: 'A thing', tags: ['api', 'work'], status: 'paused', notes: 'n' });
  assert.deepEqual(stored.skills, { x: { favorite: true, tags: [] } });
  assert.deepEqual(stored.unknown, { a: 1 });
  assert.deepEqual(stored.projectRoots, ['~/ws']);

  assert.deepEqual(set({ addTags: ['b'], removeTags: ['api'] }).tags, ['b', 'work']);
  assert.deepEqual(set({ description: '' }).description, ''); // clear one field, rest kept
  assert.equal(readProjectMeta({ home }).get(dir).status, 'paused');

  bad({ description: 'x'.repeat(301) });
  bad({ notes: 'x'.repeat(2001) });
  bad({ description: 5 });
  bad({ status: 'done' });
  bad({ tags: 'a' });
  bad({ tags: ['Bad Tag'] });
  bad({ tags: ['x'.repeat(25)] });
  bad({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) });
  bad({ addTags: [''] });
  bad({ root: 'relative' });
  bad({ root: path.join(ws, 'missing') }, 'not-found');
  bad({ root: repo(path.join(tmp(), 'out')) }, 'forbidden');
  assert.equal(set({ description: 'x'.repeat(300) }).description.length, 300);
  assert.deepEqual(rawConfig(home).projects[dir].tags, ['b', 'work']); // failed writes changed nothing

  // clearing everything prunes the entry and then the empty `projects` key; the rest of the file survives
  set({ description: '', notes: '', status: '', tags: [] });
  const after = rawConfig(home);
  assert.equal('projects' in after, false);
  assert.deepEqual(after.skills, { x: { favorite: true, tags: [] } });
  assert.deepEqual(after.unknown, { a: 1 });
  // an unknown status or junk stored by hand is dropped on read, not fatal
  fs.writeFileSync(configPath(home), JSON.stringify({ projects: { [dir]: { status: 'weird', tags: ['OK', 'ok'], description: 5 }, '/nope': 'junk' } }));
  assert.deepEqual([...readProjectMeta({ home })], [[dir, { description: '', tags: ['ok'], status: '', notes: '' }]]); // 'OK' fails the tag rule, 'ok' stays
});

test('project meta: the current project is allowed even outside the configured roots', () => {
  const home = tmp();
  const cur = repo(path.join(tmp(), 'cur'));
  assert.equal(updateProjectMeta({ home, cwd: cur }, { root: cur, status: 'active' }).status, 'active');
  assert.throws(() => updateProjectMeta({ home, cwd: home }, { root: cur, status: 'active' }), (e) => e.code === 'forbidden');
});

test('scan: entries carry meta and auto; one broken project does not break the others', async () => {
  const home = tmp();
  const ws = path.join(home, 'ws');
  const a = repo(path.join(ws, 'a'), { remote: 'https://tok@github.com/me/a.git', files: { 'README.md': 'Alpha project.\n' } });
  repo(path.join(ws, 'b'));
  writeConfig({ home }, { projectRoots: [ws] });
  updateProjectMeta({ home, cwd: home }, { root: a, description: 'Mine', tags: ['x'] });
  const { projects } = await scanProjects({ home, git: (args, o) => { if (o.cwd.endsWith('b')) throw new Error('nope'); return execFileSync('git', args, { cwd: o.cwd, encoding: 'utf8' }); } });
  assert.deepEqual(Object.keys(projects[0]), ['root', 'name', 'meta', 'auto', 'skills']);
  assert.deepEqual(projects[0].meta, { description: 'Mine', tags: ['x'], status: '', notes: '' });
  assert.equal(projects[0].auto.remote, 'github.com/me/a');
  assert.equal(projects[0].auto.readme, 'Alpha project.');
  assert.deepEqual(projects[1].meta, { description: '', tags: [], status: '', notes: '' });
  assert.deepEqual(projects[1].auto, { stack: [] });
});

let srv;
let home;
let ws;
let cur;
before(async () => {
  home = tmp();
  ws = path.join(home, 'ws');
  repo(path.join(ws, 'react-apps'), { remote: 'git@github.com:me/react-apps.git', files: { 'package.json': '{"dependencies":{"react":"1","vite":"1"}}', 'README.md': 'Collection of React experiments.\n' } });
  repo(path.join(ws, 'sync-plugin'), { files: { 'config.xml': '' } });
  repo(path.join(ws, 'old-thing'));
  cur = repo(path.join(tmp(), 'cur'));
  writeConfig({ home }, { projectRoots: [ws] });
  srv = await startServer({ home, cwd: cur, port: 0 });
});
after(() => srv.close());
const call = async (p, init) => {
  const res = await fetch(srv.url + p, init);
  return { status: res.status, body: await res.json() };
};
const json = (method, body, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('server: /api/projects has meta + auto and ?q= uses the shared matching', async () => {
  const { body } = await call('/api/projects');
  const ra = body.projects.find((p) => p.name === 'react-apps');
  assert.deepEqual(ra.auto.stack, ['node', 'react', 'vite']);
  assert.equal(ra.auto.remote, 'github.com/me/react-apps');
  assert.deepEqual(ra.meta, { description: '', tags: [], status: '', notes: '' });
  assert.deepEqual((await call('/api/projects?q=react')).body.projects.map((p) => p.name), ['react-apps']);
  assert.deepEqual((await call('/api/projects?q=cordova%20sync')).body.projects.map((p) => p.name), ['sync-plugin']);
  assert.deepEqual((await call('/api/projects?q=react%20cordova')).body.projects, []);
  assert.equal((await call('/api/projects?q=')).body.projects.length, 3);
  assert.equal((await call('/api/projects?q=%20')).body.projects.length, 3);
});

test('server: POST /api/project-meta writes meta, guards roots, same origin only', async () => {
  const root = path.join(ws, 'old-thing');
  const ok = await call('/api/project-meta', json('POST', { root, description: 'Legacy', status: 'archived', tags: ['b', 'a'] }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, meta: { description: 'Legacy', tags: ['a', 'b'], status: 'archived', notes: '' } });
  const listed = (await call('/api/projects')).body.projects.find((p) => p.name === 'old-thing');
  assert.equal(listed.meta.status, 'archived'); // archived stays in the API
  assert.deepEqual((await call('/api/projects?q=legacy')).body.projects.map((p) => p.name), ['old-thing']);
  assert.equal((await call('/api/project-meta', json('POST', { root, addTags: ['c'], removeTags: ['a'] }))).body.meta.tags.join(), 'b,c');
  assert.equal((await call('/api/project-meta', json('POST', { root, description: '' }))).body.meta.description, '');

  const code = async (body, status, c) => {
    const r = await call('/api/project-meta', json('POST', body));
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.code, c);
    assert.equal(r.body.ok, false);
  };
  const outside = repo(path.join(tmp(), 'out'));
  await code({ root: outside, description: 'x' }, 403, 'forbidden');
  await code({ root: path.join(ws, 'missing') }, 404, 'not-found');
  await code({ description: 'x' }, 400, 'invalid');
  await code({ root, status: 'nope' }, 400, 'invalid');
  await code({ root, tags: ['BAD TAG'] }, 400, 'invalid');
  assert.equal(rawConfig(home).projects[outside], undefined);
  const cross = await call('/api/project-meta', json('POST', { root, notes: 'x' }, { origin: 'http://evil.example' }));
  assert.equal(cross.status, 403);
  assert.equal(rawConfig(home).projects[root].notes ?? '', '');
  assert.equal((await call('/api/project-meta', json('POST', { root: cur, status: 'active' }))).status, 200); // current project
  assert.equal((await call('/api/project-meta')).status, 404); // GET is not an endpoint
});

// ---- CLI ----

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (h, args, cwd = h) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, FORCE_COLOR: undefined, SKM_HOME: h, NO_COLOR: '1' }, input: '', encoding: 'utf8' });

function cliHome() {
  const h = tmp();
  const root = path.join(h, 'ws');
  repo(path.join(root, 'react-apps'), { remote: 'https://ghp_SECRET@github.com/me/react-apps.git', files: { 'package.json': '{"dependencies":{"react":"1"}}', 'README.md': '# R\n\nCollection of React experiments.\n' } });
  repo(path.join(root, 'sync-plugin'), { skills: ['s', 't'], files: { 'config.xml': '' } });
  repo(path.join(root, 'old'), { skills: [] , files: {}});
  repo(path.join(root, 'g1', 'dup'));
  repo(path.join(root, 'g2', 'dup'));
  mkSkill(path.join(root, 'sync-plugin', '.claude', 'skills-inactive'), 'sleepy');
  mkSkill(path.join(root, 'old', '.claude', 'skills'), 'o');
  writeConfig({ home: h }, { projectRoots: [root] });
  return { h, root };
}

test('cli projects: DESCRIPTION and STATUS columns, auto README marked, archived hidden unless --all', () => {
  const { h, root } = cliHome();
  const set = skm(h, ['projects', 'set', 'old', '--status', 'archived']);
  assert.equal(set.status, 0, set.stderr);
  const out = skm(h, ['projects']).stdout;
  assert.match(out, /PROJECT\s+DESCRIPTION\s+STATUS\s+SKILLS\s+TOK\s+PATH/);
  assert.match(out, /react-apps\s+Collection of React experiments\.\s+active/);
  assert.doesNotMatch(out, /\bold\b/);
  assert.match(skm(h, ['projects', '--all']).stdout, /old\s+-\s+archived/);
  const brief = JSON.parse(skm(h, ['projects', '--json', '--brief']).stdout);
  assert.deepEqual(brief.map((p) => p.name), ['dup', 'dup', 'react-apps', 'sync-plugin']);
  assert.deepEqual(Object.keys(brief[2]), ['name', 'path', 'description', 'tags', 'status', 'stack', 'lastCommitAt']);
  assert.equal(brief[2].description, 'Collection of React experiments.');
  assert.equal(brief[2].path, path.join(root, 'react-apps'));
  assert.deepEqual(brief[2].stack, ['node', 'react']);
  assert.match(brief[2].lastCommitAt, /Z$/);
  const full = JSON.parse(skm(h, ['projects', '--json']).stdout);
  assert.ok(full.roots && full.repeated && full.projects.every((p) => p.meta && p.auto));
  assert.equal(full.projects.some((p) => p.name === 'old'), false);
  assert.equal(JSON.parse(skm(h, ['projects', '--json', '--all']).stdout).projects.some((p) => p.name === 'old'), true);
  assert.doesNotMatch(skm(h, ['projects', '--json', '--all']).stdout, /SECRET|ghp_|@/);
});

test('cli projects find: ranking, AND, --brief --json, archived, no match, usage', () => {
  const { h } = cliHome();
  assert.equal(skm(h, ['projects', 'set', 'sync-plugin', '--desc', 'Background sync plugin', '--tags', 'outsystems,work']).status, 0);
  const names = (...a) => JSON.parse(skm(h, ['projects', 'find', ...a, '--json', '--brief']).stdout).map((p) => p.name);
  assert.deepEqual(names('sync'), ['sync-plugin']);
  assert.deepEqual(names('SYNC', 'plugin'), ['sync-plugin']);
  assert.deepEqual(names('background outsystems'), ['sync-plugin']); // one quoted arg with spaces also splits
  assert.deepEqual(names('react', 'sync'), []);
  assert.deepEqual(names('cordova'), ['sync-plugin']);
  assert.deepEqual(names('github.com/me'), ['react-apps']);
  const table = skm(h, ['projects', 'find', 'react']);
  assert.equal(table.status, 0);
  assert.match(table.stdout, /react-apps/);
  assert.doesNotMatch(table.stdout, /sync-plugin/);
  assert.match(skm(h, ['projects', 'find', 'zzzz']).stdout, /no projects match "zzzz"/);
  assert.equal(skm(h, ['projects', 'find']).status, 1);
  skm(h, ['projects', 'set', 'old', '--status', 'archived', '--desc', 'legacy thing']);
  assert.deepEqual(names('legacy'), []);
  assert.deepEqual(JSON.parse(skm(h, ['projects', 'find', 'legacy', '--all', '--json', '--brief']).stdout).map((p) => p.name), ['old']);
  const full = JSON.parse(skm(h, ['projects', 'find', 'react', '--json']).stdout);
  assert.equal(full[0].name, 'react-apps');
  assert.ok(full[0].skills && full[0].auto && full[0].meta);
});

test('cli projects show: sheet, --json, resolution by name or path, ambiguity, not found', () => {
  const { h, root } = cliHome();
  skm(h, ['projects', 'set', 'sync-plugin', '--desc', 'Background sync plugin', '--tags', 'work', '--note', 'wip']);
  const sheet = skm(h, ['projects', 'show', 'sync-plugin']);
  assert.equal(sheet.status, 0, sheet.stderr);
  for (const re of [/path\s+.*sync-plugin/, /stack\s+cordova/, /branch\s+main/, /last commit\s+\d{4}-/, /description\s+Background sync plugin/, /tags\s+work/, /status\s+active/, /notes\s+wip/, /2 active, 1 inactive/, /sleepy \(inactive\)/]) assert.match(sheet.stdout, re);
  const auto = skm(h, ['projects', 'show', 'react-apps']).stdout;
  assert.match(auto, /remote\s+github\.com\/me\/react-apps\n/);
  assert.match(auto, /description\s+Collection of React experiments\. \(from README, auto\)/);
  assert.doesNotMatch(auto, /SECRET|@/);
  const j = JSON.parse(skm(h, ['projects', 'show', path.join(root, 'react-apps'), '--json']).stdout);
  assert.equal(j.name, 'react-apps');
  assert.equal(j.auto.remote, 'github.com/me/react-apps');
  assert.equal(skm(h, ['projects', 'show', 'react-apps'], path.join(root, 'sync-plugin')).status, 0);
  assert.equal(skm(h, ['projects', 'show', '../react-apps'], path.join(root, 'sync-plugin')).status, 0); // relative path

  const amb = skm(h, ['projects', 'show', 'dup']);
  assert.equal(amb.status, 1);
  assert.ok(amb.stderr.includes(path.join(root, 'g1', 'dup')) && amb.stderr.includes(path.join(root, 'g2', 'dup')), amb.stderr);
  assert.equal(JSON.parse(skm(h, ['projects', 'show', path.join(root, 'g2', 'dup'), '--json']).stdout).root, path.join(root, 'g2', 'dup'));
  for (const bad of [['show', 'nope'], ['show'], ['set', 'nope', '--desc', 'x']]) {
    const r = skm(h, ['projects', ...bad]);
    assert.equal(r.status, 1, bad.join(' '));
  }
});

test('cli projects set: every flag, validation, exit codes, outside roots', () => {
  const { h, root } = cliHome();
  const cfgBefore = rawConfig(h);
  const run = (...a) => skm(h, ['projects', 'set', 'react-apps', ...a]);
  const meta = () => rawConfig(h).projects?.[path.join(root, 'react-apps')];

  let r = run('--desc', 'Frontend experiments', '--tags', 'react,work', '--status', 'paused', '--note', 'mine');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated react-apps/);
  assert.deepEqual(meta(), { description: 'Frontend experiments', tags: ['react', 'work'], status: 'paused', notes: 'mine' });
  run('--add-tag', 'ui,Extra', '--rm-tag', 'work');
  assert.deepEqual(meta().tags, ['extra', 'react', 'ui']);
  assert.equal(JSON.parse(run('--tags', 'a', '--json').stdout).meta.tags.join(), 'a');
  assert.equal(run('--clear', 'tags').status, 0);
  assert.deepEqual(meta().tags, []);
  assert.equal(run('--clear', 'desc,notes').status, 0);
  assert.deepEqual(meta(), { description: '', tags: [], status: 'paused', notes: '' });
  assert.equal(run('--clear', 'status').status, 0);
  assert.equal(meta(), undefined); // pruned
  assert.equal('projects' in rawConfig(h), false);
  assert.deepEqual(rawConfig(h), cfgBefore); // everything else untouched

  for (const bad of [[], ['--desc', 'x'.repeat(301)], ['--status', 'done'], ['--tags', 'Bad Tag'], ['--clear', 'everything'], ['--desc'], ['--note', 'x'.repeat(2001)]]) {
    const b = run(...bad);
    assert.equal(b.status, 1, bad.join(' '));
    assert.match(b.stderr, /^skm: /);
  }
  assert.equal(meta(), undefined);

  // by path, including a project that has no skills and one outside every root
  const bare = repo(path.join(root, 'bare'), { skills: [] });
  assert.equal(skm(h, ['projects', 'set', bare, '--desc', 'No skills yet']).status, 0);
  assert.equal(rawConfig(h).projects[bare].description, 'No skills yet');
  const outside = repo(path.join(tmp(), 'out'));
  const o = skm(h, ['projects', 'set', outside, '--desc', 'x']);
  assert.equal(o.status, 1);
  assert.match(o.stderr, /forbidden/);
  assert.equal(rawConfig(h).projects[outside], undefined);
});

test('the skm skill lints clean and follows the contract', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'skm');
  assert.deepEqual(lintSkill(dir, 'skm'), []);
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^name: skm$/m);
  assert.ok(fm.match(/^description: (.*)$/m)[1].length < 300);
  for (const needle of ['skm projects find', '--json --brief', 'skm projects show', 'skm projects set', 'npm link', 'alias', 'skm list', 'skm doctor', 'skm cost', 'skm lint', 'skm outdated', 'skm update', 'skm pull', 'skm promote']) assert.ok(md.includes(needle), needle);
});
