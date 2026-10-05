import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { startServer } from '../src/server.mjs';
import { buildHome } from './fixture.mjs';

let srv;
let home;
before(async () => {
  home = buildHome();
  srv = await startServer({ home, cwd: home, port: 0 });
});
after(() => srv.close());

const call = async (path, init) => {
  const res = await fetch(srv.url + path, init);
  return { status: res.status, body: await res.json() };
};
const post = (body, headers = {}) =>
  call('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('binds to 127.0.0.1 only', () => {
  assert.equal(srv.server.address().address, '127.0.0.1');
});

test('GET /api/state', async () => {
  const { status, body } = await call('/api/state');
  assert.equal(status, 200);
  assert.equal(body.project, null);
  assert.deepEqual(body.local, []);
  assert.ok(body.global.find((s) => s.name === 'good' && s.status === 'ok'));
});

test('GET /api/skill', async () => {
  const { status, body } = await call('/api/skill?scope=global&name=good');
  assert.equal(status, 200);
  assert.match(body.markdown, /# good/);
  assert.deepEqual(body.tree, ['SKILL.md']);
  assert.equal(body.skill.name, 'good');
  const miss = await call('/api/skill?scope=global&name=nope');
  assert.equal(miss.status, 404);
  assert.equal(miss.body.ok, false);
  assert.equal(miss.body.code, 'not-found');
});

test('POST /api/action: dryRun, real run, errors are JSON', async () => {
  const dry = await post({ action: 'normalize', scope: 'global', name: 'unlinked', dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.ok, true);
  assert.equal(dry.body.changes.length, 1);
  assert.equal(fs.existsSync(`${home}/.claude/skills/unlinked`), false);
  const real = await post({ action: 'normalize', scope: 'global', name: 'unlinked' });
  assert.equal(real.body.ok, true);
  assert.ok(fs.lstatSync(`${home}/.claude/skills/unlinked`).isSymbolicLink());
  const div = await post({ action: 'normalize', scope: 'global', name: 'split' });
  assert.equal(div.status, 409);
  assert.deepEqual([div.body.ok, div.body.code], [false, 'diverged']);
  const bad = await post({ action: 'wat', scope: 'global', name: 'good' });
  assert.equal(bad.status, 400);
  const garbage = await call('/api/action', { method: 'POST', body: '{nope' });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body.ok, false);
});

test('cross-origin POST and foreign Host are refused', async () => {
  const x = await post({ action: 'delete', scope: 'global', name: 'good' }, { origin: 'http://evil.example' });
  assert.equal(x.status, 403);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { host: 'evil.example' } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
  });
  assert.equal(status, 403);
  assert.ok(fs.existsSync(`${home}/.agents/skills/good`));
});

test('static: serves src/ui, blocks traversal, JSON 404', async () => {
  const miss = await call('/nope.css');
  assert.equal(miss.status, 404);
  const res = await fetch(`${srv.url}/..%2f..%2fpackage.json`);
  assert.ok([403, 404].includes(res.status));
});

test('port fallback when taken', async () => {
  const a = await startServer({ home, cwd: home, port: srv.port });
  assert.ok(a.port > srv.port);
  await a.close();
});
