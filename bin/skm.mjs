#!/usr/bin/env node
import readline from 'node:readline/promises';
import { getState, normalizeAll, runAction, SkmError } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';

const USAGE = `skm: skills manager

  skm                     start the UI for the current dir and open the browser
  skm list [--json]       table of global + local skills with status
  skm doctor              list problems with the suggested fix
  skm normalize [name|--all] [--keep agents|claude] [--dry-run]
  skm activate|deactivate <name> [--local|--global]
  skm promote <name>      local -> global (copy)   [--overwrite]
  skm pull <name>         global -> local (copy)   [--overwrite] [--target agents|claude]
  skm delete <name> [--local|--global]   moves it to the system Trash

Options: --yes (skip confirmation) --dry-run --json --port <n> --no-open
Env: SKM_HOME overrides the home directory.`;

const FLAGS_WITH_VALUE = new Set(['--keep', '--port', '--target']);

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split(/=(.*)/s);
      if (v !== undefined) out.flags[k.slice(2)] = v;
      else if (FLAGS_WITH_VALUE.has(a)) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else if (a === '-y') out.flags.yes = true;
    else out._.push(a);
  }
  return out;
}

// ---- output --------------------------------------------------------------

const useColor = (stream) => stream.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor(process.stdout) ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { red: paint(31), green: paint(32), yellow: paint(33), magenta: paint(35), dim: paint(2), bold: paint(1) };
const STATUS_COLOR = {
  ok: c.green,
  'needs-link': c.yellow,
  duplicate: c.yellow,
  diverged: c.red,
  'claude-only': c.yellow,
  'broken-link': c.red,
  'wrong-link': c.red,
  empty: c.dim,
  conflict: c.magenta,
};
const FIX = {
  'needs-link': 'skm normalize <name>   (creates the claude symlink)',
  duplicate: 'skm normalize <name>   (replaces the claude copy with a symlink)',
  diverged: 'skm normalize <name> --keep agents|claude',
  'claude-only': 'skm normalize <name>   (adopts it into ~/.agents/skills)',
  'broken-link': 'skm normalize <name>   (or skm delete <name>)',
  'wrong-link': 'skm normalize <name>   (relinks to the agents folder)',
  empty: 'add a SKILL.md, or skm delete <name>',
  conflict: 'resolve the *.sync-conflict-* files by hand, then delete them',
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - strip(s).length));

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => strip(r[i]).length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]))).join('  ').trimEnd()).join('\n');
}

function listAll(state) {
  return [...state.global, ...state.local];
}

function printList(state) {
  const skills = listAll(state);
  if (!skills.length) return console.log('no skills found');
  const rows = [['SCOPE', 'NAME', 'STATE', 'STATUS', 'ALSO IN'].map((h) => c.bold(h))];
  for (const s of skills) {
    const color = STATUS_COLOR[s.status] ?? ((x) => x);
    rows.push([
      s.scope,
      s.name,
      s.active ? 'active' : c.dim('inactive'),
      color(s.status),
      s.alsoIn.join(', '),
    ]);
  }
  console.log(table(rows));
  if (!state.project) console.log(c.dim('\n(no project detected from the current directory: global skills only)'));
}

// ---- helpers -------------------------------------------------------------

async function confirm(question, flags) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) throw new SkmError('invalid', `${question} [y/N]\nconfirmation required: re-run with --yes (not a TTY)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Pick the scope for a name: explicit flag, else the unique match among `allowed`. */
function resolveScope(state, name, flags, allowed = ['global', 'local']) {
  if (flags.local) return 'local';
  if (flags.global) return 'global';
  const hits = allowed.filter((sc) => state[sc].some((s) => s.name === name));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new SkmError('not-found', `no skill named "${name}"`);
  throw new SkmError('ambiguous', `"${name}" exists in both scopes: pass --local or --global`);
}

function report(result, flags) {
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(result.message);
  for (const ch of result.changes ?? []) console.log(`  ${ch}`);
  for (const sk of result.skipped ?? []) console.log(c.yellow(`  skipped ${sk}`));
}

/** Plain-language warning for delete: what goes, the exact Trash destination (from the dry-run plan), how to get it back. */
function deleteQuestion(req, plan) {
  const dests = plan.changes.map((ch) => /^trash .+? -> (.+)$/.exec(ch)?.[1]).filter(Boolean);
  const where = dests.length ? ` (${dests.join(', ')})` : '';
  return `${req.name} will be removed from ${req.scope} and moved to the system Trash${where}.\n`
    + 'To get it back, restore it from the Trash by hand.\nContinue?';
}

async function perform(opts, req, flags, { destructive = false } = {}) {
  const dryRun = Boolean(flags['dry-run']);
  if (destructive && !dryRun) {
    const plan = runAction(opts, { ...req, dryRun: true });
    for (const ch of plan.changes) console.log(`  ${ch}`);
    const question = req.action === 'delete' ? deleteQuestion(req, plan) : `${req.action} ${req.name}?`;
    if (!(await confirm(question, flags))) {
      console.log('aborted');
      return;
    }
  }
  report(runAction(opts, { ...req, dryRun }), flags);
}

// ---- commands ------------------------------------------------------------

async function main(argv, opts = {}) {
  const { _: pos, flags } = parseArgs(argv);
  const [cmd, name] = pos;
  if (flags.help || flags.h || cmd === 'help') return console.log(USAGE);

  if (!cmd || cmd === 'ui') {
    const port = flags.port ? Number(flags.port) : 4747;
    const { url } = await startServer({ ...opts, port, open: !flags['no-open'] });
    console.log(`skm UI running at ${url}  (Ctrl+C to stop)`);
    return;
  }

  const state = getState(opts);
  switch (cmd) {
    case 'list':
      if (flags.json) return console.log(JSON.stringify(state, null, 2));
      return printList(state);

    case 'doctor': {
      const bad = listAll(state).filter((s) => s.issues.length || s.status !== 'ok');
      if (flags.json) return console.log(JSON.stringify(bad, null, 2));
      if (!bad.length) return console.log(c.green('all skills look healthy'));
      for (const s of bad) {
        const color = STATUS_COLOR[s.status] ?? ((x) => x);
        console.log(`${c.bold(`${s.scope}/${s.name}`)}  ${color(s.status)}`);
        for (const i of s.issues) console.log(`  - ${i}`);
        if (FIX[s.status]) console.log(`  fix: ${FIX[s.status].replace('<name>', s.name)}`);
      }
      process.exitCode = 1;
      return;
    }

    case 'normalize': {
      if (flags.all || !name) {
        if (!flags.all) throw new SkmError('invalid', 'usage: skm normalize <name> | --all');
        const dryRun = Boolean(flags['dry-run']);
        if (!dryRun) {
          const plan = normalizeAll(opts, { keep: flags.keep, dryRun: true });
          if (!plan.changes.length) return report(plan, flags);
          for (const ch of plan.changes) console.log(`  ${ch}`);
          if (!(await confirm('apply these changes?', flags))) return console.log('aborted');
        }
        return report(normalizeAll(opts, { keep: flags.keep, dryRun }), flags);
      }
      return perform(opts, { action: 'normalize', scope: 'global', name, keep: flags.keep }, flags, { destructive: true });
    }

    case 'activate':
    case 'deactivate': {
      if (!name) throw new SkmError('invalid', `usage: skm ${cmd} <name>`);
      return perform(opts, { action: cmd, scope: resolveScope(state, name, flags), name }, flags);
    }

    case 'promote':
    case 'pull': {
      if (!name) throw new SkmError('invalid', `usage: skm ${cmd} <name>`);
      const req =
        cmd === 'promote'
          ? { action: 'promote', scope: 'local', name, overwrite: Boolean(flags.overwrite) }
          : { action: 'copyToLocal', scope: 'global', name, overwrite: Boolean(flags.overwrite), target: flags.target };
      return perform(opts, req, flags, { destructive: Boolean(flags.overwrite) });
    }

    case 'delete': {
      if (!name) throw new SkmError('invalid', 'usage: skm delete <name>');
      return perform(opts, { action: 'delete', scope: resolveScope(state, name, flags), name }, flags, { destructive: true });
    }

    default:
      throw new SkmError('invalid', `unknown command: ${cmd}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof SkmError) console.error(`skm: ${err.message}${err.code === 'ambiguous' ? '' : ` [${err.code}]`}`);
  else console.error(err);
  process.exitCode = 1;
});
