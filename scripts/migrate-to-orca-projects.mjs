#!/usr/bin/env node
// Move the indexed projects that live under ~/Documents into ~/orca/projects (dry run unless --apply).
//
// What it does per project: rename the folder, re-key its skm meta in config.json, rename its Claude Code
// history folder (~/.claude/projects/<encoded path>). Ignored projects are never touched (scanProjects prunes them).
// What it leaves to you: re-registering repos in Orca, recreating virtualenvs, external references to the old path.
//
//   node scripts/migrate-to-orca-projects.mjs            # plan only
//   node scripts/migrate-to-orca-projects.mjs --apply    # do it
//   options: --from <dir> (default ~/Documents)  --to <dir> (default ~/orca/projects)
//
// Run it from a terminal that may read ~/Documents (macOS privacy), once.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, readRaw, writeJsonFile } from '../src/core/config.mjs';
import { resolveContext } from '../src/core/context.mjs';
import { scanProjects } from '../src/core/projects.mjs';

const inside = (dir, root) => dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Claude Code's folder name for a project path: every non-alphanumeric character becomes "-". */
export const claudeKey = (abs) => abs.replace(/[^A-Za-z0-9]/g, '-');

/** Work out the moves without touching anything. Returns { moves, skipped }. */
export async function plan(opts = {}) {
  const ctx = resolveContext(opts);
  const from = path.resolve(opts.from ?? path.join(ctx.home, 'Documents'));
  const to = path.resolve(opts.to ?? path.join(ctx.home, 'orca', 'projects'));
  try {
    fs.readdirSync(from);
  } catch (err) {
    throw new Error(`cannot read ${from} (${err.code}). Allow this terminal under macOS Privacy & Security > Files and Folders, then retry.`);
  }
  const { projects } = await scanProjects(ctx);
  const moves = [];
  const skipped = [];
  const taken = new Set();
  for (const p of projects) {
    if (!inside(p.root, from)) continue;
    const dest = path.join(to, path.basename(p.root));
    if (fs.existsSync(dest) || taken.has(dest)) skipped.push({ root: p.root, reason: `destination exists: ${dest}` });
    else {
      taken.add(dest);
      moves.push({ from: p.root, to: dest, isGit: fs.existsSync(path.join(p.root, '.git')) });
    }
  }
  return { ctx, from, to, moves, skipped };
}

/** Execute a plan: rename folders, then re-key config meta and Claude history. Returns a report. */
export function apply({ ctx, to, moves }) {
  const report = { moved: [], failed: [], history: [], historyReview: [], meta: 0, backup: null };
  fs.mkdirSync(to, { recursive: true });
  for (const m of moves) {
    try {
      fs.renameSync(m.from, m.to);
      report.moved.push(m);
    } catch (err) {
      report.failed.push({ ...m, reason: err.code === 'EXDEV' ? 'different volume (EXDEV); move it by hand' : err.message });
    }
  }

  const histDir = path.join(ctx.home, '.claude', 'projects');
  let entries = [];
  try {
    entries = fs.readdirSync(histDir);
  } catch {}
  for (const m of report.moved) {
    const oldKey = claudeKey(m.from);
    const newKey = claudeKey(m.to);
    if (entries.includes(oldKey) && !fs.existsSync(path.join(histDir, newKey))) {
      fs.renameSync(path.join(histDir, oldKey), path.join(histDir, newKey));
      report.history.push(m.to);
    }
    // Worktree-style siblings ("<key>--...") are not renamed automatically; list them for review.
    for (const e of entries) if (e.startsWith(`${oldKey}--`)) report.historyReview.push(e);
  }

  const file = configPath(ctx.home);
  const raw = readRaw(ctx.home);
  if (raw.projects && typeof raw.projects === 'object') {
    const renames = new Map(report.moved.map((m) => [m.from, m.to]));
    const next = {};
    for (const [k, v] of Object.entries(raw.projects)) {
      const dest = renames.get(k);
      if (dest) report.meta++;
      next[dest ?? k] = v;
    }
    if (report.meta) {
      report.backup = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, report.backup);
      writeJsonFile(file, { ...raw, projects: next });
    }
  }
  return report;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const val = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  plan({ from: val('--from'), to: val('--to') })
    .then((p) => {
      console.log(`${p.moves.length} to move from ${p.from} to ${p.to}`);
      for (const m of p.moves) console.log(`  ${path.basename(m.from)}${m.isGit ? '' : '  (not a git repo)'}`);
      for (const s of p.skipped) console.log(`  SKIP ${s.root}: ${s.reason}`);
      if (!flag('--apply')) return console.log('\nDry run. Re-run with --apply to move them.');
      const r = apply(p);
      console.log(`\nmoved ${r.moved.length}, failed ${r.failed.length}, meta re-keyed ${r.meta}, Claude history renamed ${r.history.length}`);
      for (const f of r.failed) console.log(`  FAILED ${f.from}: ${f.reason}`);
      if (r.backup) console.log(`config backup: ${r.backup}`);
      if (r.historyReview.length) console.log(`review by hand in ~/.claude/projects:\n  ${r.historyReview.join('\n  ')}`);
      const repos = r.moved.filter((m) => m.isGit);
      if (repos.length) {
        console.log('\nRe-register in Orca (skip the ones that were never registered):');
        for (const m of repos) console.log(`  orca repo add ${m.to}`);
      }
      console.log('\nStill yours: recreate .venv folders, and update RunApps/launchd/Docker references to the old paths.');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
