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

// ---- provenance: list, outdated, update (offline: file:// source, no GitHub calls) ----

import { execFileSync } from 'node:child_process';
import { gitTreeHash, lockPath } from '../src/core/index.mjs';
import { write } from './fixture.mjs';

function updatableHome() {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'skm-src-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo });
  g('init', '-q', '-b', 'main');
  write(path.join(repo, 'skills/good/SKILL.md'), '---\nname: good\ndescription: v2\n---\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'v2');
  const home = buildHome();
  const hash = gitTreeHash(path.join(home, '.agents', 'skills', 'good'));
  const entry = (extra) => ({ source: 'o/good', sourceType: 'github', sourceUrl: `file://${repo}`, skillPath: 'skills/good/SKILL.md', skillFolderHash: hash, installedAt: 'a', updatedAt: 'a', ...extra });
  write(lockPath(home), JSON.stringify({ version: 3, skills: { good: entry(), unknown: entry() } }, null, 2));
  return home;
}

test('cli list: ORIGIN column and modified marker', () => {
  const home = updatableHome();
  let r = skm(home, ['list']);
  assert.match(r.stdout, /ORIGIN/);
  assert.match(r.stdout, /good\s+active\s+ok\s+\d+\s+o\/good\s*$/m);
  assert.match(r.stdout, /unlinked\s+active\s+needs-link\s+\d+\s+-\s*$/m);
  write(path.join(home, '.agents', 'skills', 'good', 'x.md'), 'edit');
  r = skm(home, ['list']);
  assert.match(r.stdout, /o\/good \[modified\]/);
  assert.equal(JSON.parse(skm(home, ['list', '--json']).stdout).global.find((s) => s.name === 'good').origin.modified, true);
});

test('cli outdated: no lock means a plain message, no network', () => {
  const r = skm(buildHome(), ['outdated']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no installed skill has a GitHub source/);
});

test('cli update: non-interactive asks for --yes and changes nothing; --dry-run and --yes work', { skip: !supported }, () => {
  const home = updatableHome();
  const dir = path.join(home, '.agents', 'skills', 'good');
  let r = skm(home, ['update', 'good']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /system Trash/);
  assert.match(r.stderr, /re-run with --yes/);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /good skill/);
  r = skm(home, ['update', 'good', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run: updated global\/good/);
  assert.doesNotMatch(r.stdout, /Continue/);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /good skill/);
  r = skm(home, ['update', 'good', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /v2/);
  assert.ok(fs.existsSync(path.join(trashed(home), 'SKILL.md')));
  // modified refuses; not-tracked errors
  write(path.join(dir, 'mine.md'), 'x');
  r = skm(home, ['update', 'good', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[modified\]/);
  r = skm(home, ['update', 'dup', '--yes']);
  assert.match(r.stderr, /\[not-tracked\]/);
});

test('cli list has a TOK column; cost, lint and diff subcommands', { skip: !supported }, () => {
  const home = buildHome();
  const list = skm(home, ['list']);
  assert.match(list.stdout.split('\n')[0], /STATUS\s+TOK\s+ORIGIN/);
  const cost = skm(home, ['cost', '--json']);
  const c = JSON.parse(cost.stdout);
  assert.ok(c.skills.every((s) => s.active) && c.totals.listingTokens > 0);
  assert.match(skm(home, ['cost']).stdout, /tokens loaded in every session/);
  const lint = skm(home, ['lint']);
  assert.equal(lint.status, 1); // youtube_transcript_skill has no SKILL.md (error)
  assert.match(lint.stdout, /no-skill-md/);
  assert.equal(skm(home, ['lint', 'good']).status, 0);
  assert.equal(skm(home, ['lint', 'nope']).status, 1);
  assert.match(skm(home, ['diff', 'good']).stderr, /not-tracked/);
});
