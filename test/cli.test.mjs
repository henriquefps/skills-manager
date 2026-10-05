import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildHome } from './fixture.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.mjs');
const skm = (home, args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    env: { ...process.env, SKM_HOME: home, NO_COLOR: '1' },
    input: '',
    encoding: 'utf8',
  });

// The CLI uses the real platform; the layouts under test are mac and linux.
const supported = ['darwin', 'linux'].includes(process.platform);
const trashed = (home) =>
  process.platform === 'darwin' ? path.join(home, '.Trash', 'good') : path.join(home, '.local', 'share', 'Trash', 'files', 'good');

test('cli delete: non-interactive prompt names the exact Trash destination and moves nothing', { skip: !supported }, () => {
  const home = buildHome();
  const r = skm(home, ['delete', 'good', '--global']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`good will be removed from global and moved to the system Trash (${trashed(home)}).`), r.stderr);
  assert.match(r.stderr, /restore it from the Trash by hand\./);
  assert.match(r.stderr, /Continue\? \[y\/N\]/);
  assert.match(r.stderr, /re-run with --yes/);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'good')));
  assert.equal(fs.existsSync(trashed(home)), false);
});

test('cli delete --dry-run does not prompt and writes nothing', { skip: !supported }, () => {
  const home = buildHome();
  const r = skm(home, ['delete', 'good', '--global', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`dry run: moved global/good to the system Trash (${trashed(home)})`));
  assert.doesNotMatch(r.stdout, /Continue/);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'good')));
  assert.equal(fs.existsSync(trashed(home)), false);
});

test('cli delete --yes skips the prompt and trashes the folder', { skip: !supported }, () => {
  const home = buildHome();
  const r = skm(home, ['delete', 'good', '--global', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(trashed(home)));
  assert.ok(fs.existsSync(path.join(trashed(home), 'SKILL.md')));
});
