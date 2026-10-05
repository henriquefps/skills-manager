import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configPath, ignoredBy, readIgnore, scanProjects, SkmError, updateIgnore, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';
import { tmp } from './fixture.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (home, args, cwd = home) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, FORCE_COLOR: undefined, SKM_HOME: home, NO_COLOR: '1' }, input: '', encoding: 'utf8' });

const proj = (dir) => {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
};
const raw = (home) => JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
const rel = (scan) => scan.projects.map((p) => path.relative(scan.roots[0], p.root));

/** ws/{foo,foobar,old-stuff/{a,b},x-backup/c,android/d,keep/e} plus a nested one below foo's sibling. */
function build() {
  const home = tmp();
  const ws = path.join(home, 'ws');
  for (const d of ['foo', 'foobar', 'old-stuff/a', 'old-stuff/b', 'x-backup/c', 'android/d', 'keep/e', 'keep/Android/f']) proj(path.join(ws, d));
  writeConfig({ home }, { projectRoots: [ws], scanDepth: 3 });
  return { home, ws };
}
const scan = (home, ignore) => scanProjects({ home }, { projectRoots: [path.join(home, 'ws')], scanDepth: 3, ...(ignore ? { ignore } : {}) });

test('ignore: path prefix matches on a directory boundary', async () => {
  const { home, ws } = build();
  const s = await scan(home, [path.join(ws, 'foo')]);
  assert.ok(rel(s).includes('foobar'));
  assert.ok(!rel(s).includes('foo'));
  assert.deepEqual(s.ignored, [{ entry: path.join(ws, 'foo'), kind: 'path', matches: 1 }]);
});

test('ignore: ~ expansion, container hides everything below, matches counted, scan does not descend', async () => {
  const { home } = build();
  const s = await scan(home, ['~/ws/old-stuff/']);
  assert.ok(!rel(s).some((r) => r.startsWith('old-stuff')));
  assert.deepEqual(s.ignored, [{ entry: '~/ws/old-stuff/', kind: 'path', matches: 1 }]); // pruned once, never visited a and b
});

test('ignore: globs match basenames anywhere, case-sensitive, only * is a wildcard', async () => {
  const { home } = build();
  const s = await scan(home, ['*-backup', 'android', 'fo*']);
  assert.ok(!rel(s).includes('foo') && !rel(s).includes('foobar')); // fo* hides foo and foobar
  assert.ok(!rel(s).includes('android/d') && !rel(s).includes('x-backup/c'));
  assert.ok(rel(s).includes('keep/Android/f')); // "android" is case-sensitive
  assert.deepEqual(Object.fromEntries(s.ignored.map((i) => [i.entry, i.matches])), { '*-backup': 1, android: 1, 'fo*': 2 });
  const lit = await scan(home, ['a.d']);
  assert.equal(lit.ignored[0].matches, 0); // "." is literal, not a regex dot
});

test('ignore: the current project (and the folders above it) is never hidden', async () => {
  const { home, ws } = build();
  const cwd = path.join(ws, 'old-stuff', 'a');
  const s = await scanProjects({ home, cwd }, { projectRoots: [ws], scanDepth: 3, ignore: ['~/ws/old-stuff', 'a'] });
  assert.ok(rel(s).includes('old-stuff/a'));
  assert.ok(!rel(s).includes('old-stuff/b'));
  assert.equal(ignoredBy({ home, cwd }, cwd), null);
});

test('ignore: updateIgnore round trip keeps every other key; ~ stored for home paths; empty list drops the key', () => {
  const { home, ws } = build();
  fs.writeFileSync(configPath(home), JSON.stringify({ ...raw(home), extra: { x: 1 }, skills: { s: { favorite: true, tags: [] } } }));
  const r = updateIgnore({ home }, { add: [path.join(ws, 'old-stuff'), 'android', 'android', '~/ws/old-stuff'] });
  assert.deepEqual(r.added, ['~/ws/old-stuff', 'android']);
  assert.deepEqual(raw(home).ignore, ['~/ws/old-stuff', 'android']);
  assert.deepEqual(raw(home).extra, { x: 1 });
  assert.deepEqual(raw(home).skills, { s: { favorite: true, tags: [] } });
  writeConfig({ home }, { scanDepth: 2 }); // other writers keep ignore too
  assert.deepEqual(readIgnore({ home }), ['~/ws/old-stuff', 'android']);
  const back = updateIgnore({ home }, { remove: ['/' + path.relative('/', path.join(ws, 'old-stuff')), 'android'] });
  assert.deepEqual(back.ignore, []);
  assert.equal('ignore' in raw(home), false);
  assert.deepEqual(raw(home).extra, { x: 1 });
});

test('ignore: validation errors and the forbidden rule', () => {
  const { home, ws } = build();
  const code = (req) => {
    try {
      updateIgnore({ home }, req);
    } catch (e) {
      assert.ok(e instanceof SkmError);
      return e.code;
    }
    return 'none';
  };
  for (const bad of ['', '  ', 5, 'rel/path', './x/y', 'a?b', 'a[b]', '**', '*', '..', '~', '/', home, `${home}/`, '~/']) assert.equal(code({ add: [bad] }), 'invalid', String(bad));
  assert.equal(code({ add: 'x' }), 'invalid');
  assert.equal(code({ add: Array.from({ length: 201 }, (_, i) => `n${i}`) }), 'invalid');
  assert.equal(code([]), 'invalid');
  assert.equal(code({ add: [path.join(tmp(), 'elsewhere')] }), 'forbidden');
  assert.equal(code({ add: ['~/other'] }), 'forbidden');
  assert.equal(code({ add: [path.join(ws, 'gone-dir')] }), 'none'); // inside a root, may no longer exist
  assert.equal(fs.existsSync(configPath(home)), true);
});

test('ignore: API lists ignored, validates, guards cross-origin and forbidden', async () => {
  const { home, ws } = build();
  const srv = await startServer({ home, cwd: home, port: 0 });
  try {
    const post = (body, headers = {}) => fetch(`${srv.url}/api/project-ignore`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let r = await post({ add: ['~/ws/old-stuff', 'android', '*-nothing'] });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, ignore: ['~/ws/old-stuff', 'android', '*-nothing'] });
    const list = await (await fetch(`${srv.url}/api/projects`)).json();
    assert.deepEqual(list.ignored, [
      { entry: '~/ws/old-stuff', kind: 'path', matches: 1 },
      { entry: 'android', kind: 'glob', matches: 1 },
      { entry: '*-nothing', kind: 'glob', matches: 0 },
    ]);
    assert.ok(!list.projects.some((p) => p.root.includes('old-stuff') || p.name === 'd'));
    assert.equal((await post({ add: ['~/ws/x'] }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ add: ['/etc'] })).status, 403);
    assert.equal((await post({ add: ['~'] })).status, 400);
    assert.equal((await post({ add: [''] })).status, 400);
    r = await post({ remove: ['*-nothing', 'android'] });
    assert.deepEqual((await r.json()).ignore, ['~/ws/old-stuff']);
    assert.equal(fs.existsSync(path.join(ws, 'old-stuff', 'a')), true);
  } finally {
    await srv.close();
  }
});

test('cli: ignore / ignored / unignore with name resolution, ambiguity, footer, find and show', () => {
  const { home, ws } = build();
  proj(path.join(ws, 'keep', 'foo')); // second project named foo
  let r = skm(home, ['projects', 'ignore', 'foo']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /matches 2 projects/);
  assert.ok(r.stderr.includes(path.join(ws, 'foo')) && r.stderr.includes(path.join(ws, 'keep', 'foo')));
  assert.equal('ignore' in raw(home), false);

  r = skm(home, ['projects', 'ignore', 'foobar', '*-backup', 'android']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(raw(home).ignore, ['~/ws/foobar', '*-backup', 'android']);
  r = skm(home, ['projects', 'ignore', 'nope-such']); // no project of that name: stored as a name glob
  assert.deepEqual(raw(home).ignore.at(-1), 'nope-such');

  r = skm(home, ['projects', 'ignored', '--json']);
  assert.deepEqual(JSON.parse(r.stdout), [
    { entry: '~/ws/foobar', kind: 'path', matches: 1 },
    { entry: '*-backup', kind: 'glob', matches: 1 },
    { entry: 'android', kind: 'glob', matches: 1 },
    { entry: 'nope-such', kind: 'glob', matches: 0 },
  ]);
  r = skm(home, ['projects', 'ignored']);
  assert.match(r.stdout, /ENTRY\s+KIND\s+HIDES/);

  r = skm(home, ['projects']);
  assert.match(r.stdout, /3 ignored \(skm projects ignored\)/);
  assert.doesNotMatch(r.stdout, /foobar|x-backup/);

  r = skm(home, ['projects', 'show', path.join(ws, 'foobar')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is ignored by "~\/ws\/foobar"/);
  assert.match(r.stderr, /skm projects unignore "~\/ws\/foobar"/);
  r = skm(home, ['projects', 'show', path.join(ws, 'x-backup', 'c')]); // hidden by an ancestor glob
  assert.match(r.stderr, /ignored by "\*-backup"/);
  r = skm(home, ['projects', 'find', path.join(ws, 'foobar')]);
  assert.match(r.stderr, /ignored by/);
  r = skm(home, ['projects', 'find', 'zzz']);
  assert.match(r.stdout, /no projects match "zzz"/);
  assert.match(r.stdout, /3 ignored/);

  r = skm(home, ['projects', 'unignore', 'foobar', 'android', '~/ws/foobar']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(raw(home).ignore, ['*-backup', 'nope-such']);
  r = skm(home, ['projects', 'unignore', path.join(ws, 'x-backup', 'c')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hidden by "\*-backup"/);
  r = skm(home, ['projects', 'unignore', 'missing']);
  assert.equal(r.status, 1);
  r = skm(home, ['projects', 'unignore', '*-backup', 'nope-such']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal('ignore' in raw(home), false);
  assert.doesNotMatch(skm(home, ['projects']).stdout, /ignored \(/);
});
