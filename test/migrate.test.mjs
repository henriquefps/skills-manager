import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { apply, claudeKey, plan } from '../scripts/migrate-to-orca-projects.mjs';
import { tmp, write } from './fixture.mjs';

function setup() {
  const home = tmp();
  const docs = path.join(home, 'Documents');
  for (const n of ['alpha', 'beta', 'ignored-one', 'clash']) fs.mkdirSync(path.join(docs, 'my-apps', n, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, 'orca', 'projects', 'clash'), { recursive: true });
  const alpha = path.join(docs, 'my-apps', 'alpha');
  write(path.join(home, '.claude', 'projects', claudeKey(alpha), 'session.jsonl'), '{}');
  write(
    path.join(home, '.config', 'skm', 'config.json'),
    JSON.stringify({
      projectRoots: ['~/Documents/my-apps'],
      scanDepth: 1,
      ignore: ['~/Documents/my-apps/ignored-one'],
      projects: { [alpha]: { description: 'Alpha app', tags: ['x'], status: 'active', notes: '' } },
    }),
  );
  return { home, alpha };
}

test('plan skips ignored projects and name clashes, and changes nothing', async () => {
  const { home } = setup();
  const p = await plan({ home, cwd: home });
  assert.deepEqual(p.moves.map((m) => path.basename(m.from)).sort(), ['alpha', 'beta']);
  assert.equal(p.skipped.length, 1);
  assert.match(p.skipped[0].reason, /destination exists/);
  assert.ok(fs.existsSync(path.join(home, 'Documents', 'my-apps', 'alpha')));
});

test('apply moves folders, re-keys meta, renames Claude history and backs up the config', async () => {
  const { home, alpha } = setup();
  const r = apply(await plan({ home, cwd: home }));
  const dest = path.join(home, 'orca', 'projects', 'alpha');
  assert.equal(r.moved.length, 2);
  assert.ok(fs.existsSync(path.join(dest, '.git')));
  assert.ok(!fs.existsSync(alpha));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'projects', claudeKey(dest), 'session.jsonl')));
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config', 'skm', 'config.json'), 'utf8'));
  assert.equal(cfg.projects[dest].description, 'Alpha app');
  assert.equal(cfg.projects[alpha], undefined);
  assert.deepEqual(cfg.ignore, ['~/Documents/my-apps/ignored-one']);
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.ok(fs.existsSync(path.join(home, 'Documents', 'my-apps', 'ignored-one')));
});

test('plan explains an unreadable source folder', async () => {
  const home = tmp();
  await assert.rejects(plan({ home, cwd: home }), /cannot read .*Documents/);
});
