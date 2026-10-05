#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { assertSkillsExist, checkUpdates, configPath, describeProject, diffUpstream, findProjectRoot, getState, normalizeAll, projectDescription, projectStatus, readConfig, resolveContext, runAction, scanProjects, searchProjects, SkmError, statLine, updateMeta, updateProjectMeta, writeConfig } from '../src/core/index.mjs';
import { startServer } from '../src/server.mjs';

const USAGE = `skm: skills manager

  skm                     start the UI for the current dir and open the browser
  skm list [--json] [--fav] [--tag <t>]   table of global + local skills with status
  skm doctor              list problems with the suggested fix
  skm normalize [name|--all] [--keep agents|claude] [--dry-run]
  skm activate|deactivate <name> [--local|--global]
  skm promote <name>      local -> global (copy)   [--overwrite]
  skm pull <name...>      global -> local (copy, inactive ones too)   [--overwrite] [--target agents|claude]
  skm fav|unfav <name...>   mark / unmark favorites   |   skm tags   tags in use with counts
  skm tag|untag <name> <tag...>   add / remove tags
  skm delete <name> [--local|--global]   moves it to the system Trash
  skm outdated [--json]   check the GitHub source of each tracked global skill
  skm cost [--json] [--all]   context cost (estimated tokens) of active skills
  skm lint [name] [--json] [--all]   check SKILL.md content; exit 1 on errors
  skm diff <name> [--json]   installed vs upstream (local edits show as removals)
  skm update <name>|--all [--force]   update from the source; the old version goes to the system Trash
  skm projects [--json] [--brief] [--all]   scan the configured project roots (archived hidden unless --all)
  skm projects find <query...> [--json] [--brief] [--all]   projects matching every word, best first
  skm projects show <name|path> [--json]   full sheet of one project
  skm projects set <name|path> [--desc "..."] [--tags a,b] [--add-tag t] [--rm-tag t] [--status active|paused|archived]
                   [--note "..."] [--clear desc|tags|notes|status]   describe a project for agents
  skm projects add|rm <path>   |   skm projects depth <n>   |   skm config

Options: --yes (skip confirmation) --dry-run --json --port <n> --no-open
Env: SKM_HOME overrides the home directory.`;

const FLAGS_WITH_VALUE = new Set(['--keep', '--port', '--target', '--tag', '--desc', '--tags', '--add-tag', '--rm-tag', '--status', '--note', '--clear']);

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
const CHECK_COLOR = { 'up-to-date': c.green, 'update-available': c.yellow, 'removed-upstream': c.red, unreachable: c.red };
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

/** `--fav` / `--tag <t>` keep only matching skills (both given: favorites that carry the tag). */
function filterState(state, flags) {
  if (flags.tag === true || flags.tag === '') throw new SkmError('invalid', 'usage: skm list --tag <tag>');
  const tag = flags.tag === undefined ? null : String(flags.tag).trim().toLowerCase();
  if (!flags.fav && tag === null) return state;
  const keep = (s) => (!flags.fav || s.meta.favorite) && (tag === null || s.meta.tags.includes(tag));
  return { ...state, global: state.global.filter(keep), local: state.local.filter(keep) };
}

function printList(state, filtered) {
  const skills = listAll(state);
  if (!skills.length) return console.log(filtered ? 'no skills match' : 'no skills found');
  const rows = [['SCOPE', 'NAME', 'FAV', 'STATE', 'STATUS', 'TOK', 'ORIGIN', 'TAGS', 'ALSO IN'].map((h) => c.bold(h))];
  for (const s of skills) {
    const color = STATUS_COLOR[s.status] ?? ((x) => x);
    rows.push([
      s.scope,
      s.name,
      s.meta.favorite ? c.yellow('*') : '',
      s.active ? 'active' : c.dim('inactive'),
      color(s.status),
      String(s.cost?.listing ?? 0),
      s.origin ? `${s.origin.source ?? '-'}${s.origin.modified ? c.yellow(' [modified]') : ''}` : '-',
      s.meta.tags.join(',') || '-',
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
  if (flags.json) {
    if (result.ok === false) process.exitCode = 1;
    return console.log(JSON.stringify(result, null, 2));
  }
  console.log(result.message);
  for (const ch of result.changes ?? []) console.log(`  ${ch}`);
  for (const r of result.results ?? []) if (!r.ok) console.log(c.red(`  failed ${r.name}: ${r.error} [${r.code}]`));
  if (result.ok === false) process.exitCode = 1;
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
    const question = req.action === 'delete' ? deleteQuestion(req, plan) : `${req.action} ${req.names?.join(', ') ?? req.name}?`;
    if (!(await confirm(question, flags))) {
      console.log('aborted');
      return;
    }
  }
  report(runAction(opts, { ...req, dryRun }), flags);
}

/** Colored unified diff of installed -> upstream. */
function printDiff(d) {
  console.log(`${c.bold(d.name)}  ${d.from} (installed) -> ${d.to} (upstream)`);
  if (!d.files.length) return console.log('no differences');
  for (const f of d.files) {
    console.log(c.bold(`\n${f.status} ${f.path}${f.binary ? ' (binary)' : ''}`));
    for (const h of f.hunks) {
      console.log(c.magenta(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
      for (const l of h.lines) console.log(l[0] === '+' ? c.green(l) : l[0] === '-' ? c.red(l) : l);
    }
  }
  console.log(`\n${statLine(d.stats)}`);
  console.log(c.dim('installed -> upstream: your local edits show up as removals'));
}

// ---- projects ------------------------------------------------------------

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const STATUS_PAINT = { paused: c.yellow, archived: c.dim };

/** Entry for `--brief --json`: what an agent needs to pick a project. */
const brief = (p) => ({ name: p.name, path: p.root, description: projectDescription(p), tags: p.meta.tags, status: projectStatus(p), stack: p.auto.stack ?? [], lastCommitAt: p.auto.lastCommitAt ?? null });

function projectsTable(projects) {
  const rows = [['PROJECT', 'DESCRIPTION', 'STATUS', 'SKILLS', 'TOK', 'PATH'].map((h) => c.bold(h))];
  for (const p of projects) {
    const active = p.skills.filter((s) => s.active);
    const status = projectStatus(p);
    const desc = clip(projectDescription(p), 60) || '-';
    rows.push([
      p.name,
      p.meta.description ? desc : c.dim(desc),
      (STATUS_PAINT[status] ?? ((x) => x))(status),
      `${active.length}${active.length < p.skills.length ? ` (+${p.skills.length - active.length} inactive)` : ''}`,
      String(active.reduce((n, s) => n + s.cost.listing, 0)),
      p.root,
    ]);
  }
  return table(rows);
}

/** `<name|path>` -> project entry: a unique exact name among the scanned projects, else a path to a project. */
async function resolveProject(ctx, scan, arg) {
  if (!arg) throw new SkmError('invalid', 'usage: skm projects <show|set> <name|path>');
  const byName = scan.projects.filter((p) => p.name === arg);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new SkmError('ambiguous', `"${arg}" matches ${byName.length} projects, pass one of these paths:\n${byName.map((p) => `  ${p.root}`).join('\n')}`);
  const abs = path.resolve(ctx.cwd, arg === '~' || arg.startsWith('~/') ? path.join(ctx.home, arg.slice(1)) : arg);
  const known = scan.projects.find((p) => p.root === abs);
  if (known) return known;
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {}
  if (!isDir) {
    const loose = scan.projects.filter((p) => p.name.toLowerCase() === arg.toLowerCase());
    if (loose.length === 1) return loose[0];
    throw new SkmError('not-found', `no project named or located at "${arg}"`);
  }
  return describeProject(ctx, findProjectRoot(abs, ctx.home) ?? abs);
}

function printSheet(p) {
  const a = p.auto;
  const active = p.skills.filter((s) => s.active);
  const row = (k, v) => console.log(`${c.bold(k.padEnd(12))}${v}`);
  console.log(c.bold(p.name));
  row('path', p.root);
  row('remote', a.remote ?? '-');
  row('branch', a.branch ?? '-');
  row('last commit', a.lastCommitAt ?? '-');
  row('stack', a.stack?.join(', ') || '-');
  row('description', p.meta.description || (a.readme ? `${a.readme} ${c.dim('(from README, auto)')}` : '-'));
  row('tags', p.meta.tags.join(', ') || '-');
  row('status', projectStatus(p));
  row('notes', p.meta.notes || '-');
  row('skills', !p.skills.length ? 'none' : `${active.length} active${active.length < p.skills.length ? `, ${p.skills.length - active.length} inactive` : ''} (~${active.reduce((n, s) => n + s.cost.listing, 0)} tokens listed)`);
  for (const s of p.skills) console.log(`  ${s.active ? s.name : c.dim(`${s.name} (inactive)`)}  ${c.dim(`${s.cost.listing} tok`)}`);
}

const list = (v) => String(v).split(',').map((t) => t.trim()).filter(Boolean);

/** `skm projects set` flags -> POST /api/project-meta body (without `root`). */
function metaRequest(flags) {
  for (const k of ['desc', 'tags', 'add-tag', 'rm-tag', 'status', 'note', 'clear']) if (flags[k] === true) throw new SkmError('invalid', `--${k} needs a value`);
  const req = {};
  for (const what of list(flags.clear ?? '')) {
    if (what === 'desc') req.description = '';
    else if (what === 'notes' || what === 'note') req.notes = '';
    else if (what === 'status') req.status = '';
    else if (what === 'tags') req.tags = [];
    else throw new SkmError('invalid', `--clear takes desc, tags, notes or status (got "${what}")`);
  }
  if (flags.desc !== undefined) req.description = flags.desc;
  if (flags.note !== undefined) req.notes = flags.note;
  if (flags.status !== undefined) req.status = flags.status;
  if (flags.tags !== undefined) req.tags = list(flags.tags);
  if (flags['add-tag'] !== undefined) req.addTags = list(flags['add-tag']);
  if (flags['rm-tag'] !== undefined) req.removeTags = list(flags['rm-tag']);
  if (!Object.keys(req).length) throw new SkmError('invalid', 'nothing to set: pass --desc, --tags, --add-tag, --rm-tag, --status, --note or --clear');
  return req;
}

async function projectsCommand(opts, [sub, arg, ...more], flags) {
  const ctx = resolveContext(opts);
  const cfg = readConfig(ctx);
  const target = () => {
    if (!arg) throw new SkmError('invalid', `usage: skm projects ${sub} <path>`);
    return path.resolve(ctx.cwd, arg.startsWith('~') ? path.join(ctx.home, arg.slice(1)) : arg);
  };
  if (sub === 'add') {
    const next = writeConfig(ctx, { projectRoots: [...cfg.projectRoots, target()] });
    return console.log(`project roots: ${next.projectRoots.join(', ')}`);
  }
  if (sub === 'rm') {
    const t = target();
    if (!cfg.projectRoots.includes(t)) throw new SkmError('not-found', `not a configured project root: ${t}`);
    const next = writeConfig(ctx, { projectRoots: cfg.projectRoots.filter((r) => r !== t) });
    return console.log(next.projectRoots.length ? `project roots: ${next.projectRoots.join(', ')}` : 'no project roots left');
  }
  if (sub === 'depth') {
    if (!/^\d+$/.test(arg ?? '')) throw new SkmError('invalid', 'usage: skm projects depth <1-6>');
    return console.log(`scan depth: ${writeConfig(ctx, { scanDepth: Number(arg) }).scanDepth}`);
  }
  if (sub && !['find', 'show', 'set'].includes(sub)) throw new SkmError('invalid', `unknown projects subcommand: ${sub}`);

  const scan = await scanProjects(ctx);
  if (sub === 'show' || sub === 'set') {
    const p = await resolveProject(ctx, scan, arg);
    if (sub === 'show') return flags.json ? console.log(JSON.stringify(p, null, 2)) : printSheet(p);
    const meta = updateProjectMeta(ctx, { ...metaRequest(flags), root: p.root });
    if (flags.json) return console.log(JSON.stringify({ ok: true, meta }, null, 2));
    console.log(`updated ${p.name}`);
    return console.log(`  description: ${meta.description || '-'}\n  tags: ${meta.tags.join(', ') || '-'}\n  status: ${meta.status || 'active'}\n  notes: ${meta.notes || '-'}`);
  }

  const visible = (ps) => (flags.all ? ps : ps.filter((p) => p.meta.status !== 'archived'));
  let projects = visible(scan.projects);
  if (sub === 'find') {
    const query = [arg, ...more].filter((w) => w !== undefined).join(' ');
    if (!query.trim()) throw new SkmError('invalid', 'usage: skm projects find <query...>');
    projects = searchProjects(projects, query);
    if (flags.json) return console.log(JSON.stringify(flags.brief ? projects.map(brief) : projects, null, 2));
    if (!projects.length) return console.log(`no projects match "${query}"`);
    return console.log(projectsTable(projects));
  }
  if (flags.json) return console.log(JSON.stringify(flags.brief ? projects.map(brief) : { ...scan, projects }, null, 2));
  if (!scan.roots.length) return console.log('no project roots configured: add one with `skm projects add <path>`');
  console.log(c.dim(`roots: ${scan.roots.join(', ')} (depth ${cfg.scanDepth})`));
  if (!projects.length) return console.log(scan.projects.length ? 'only archived projects found: use --all' : 'no projects found');
  console.log(projectsTable(projects));
  if (scan.repeated.length) {
    console.log(`\n${c.bold('Repeated skills')}`);
    for (const r of scan.repeated) {
      const kind = r.identical ? c.green('identical') : c.red('diverged');
      console.log(`  ${r.name}  ${kind}${r.inGlobal ? c.dim(' (also global)') : ''}  in ${r.projects.length}: ${r.projects.map((p) => path.basename(p)).join(', ')}`);
    }
  }
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
    case 'list': {
      const shown = filterState(state, flags);
      if (flags.json) return console.log(JSON.stringify(shown, null, 2));
      return printList(shown, shown !== state);
    }

    case 'fav':
    case 'unfav': {
      const names = pos.slice(1);
      if (!names.length) throw new SkmError('invalid', `usage: skm ${cmd} <name...>`);
      assertSkillsExist(opts, names);
      const result = names.map((n) => ({ name: n, meta: updateMeta(opts, { name: n, favorite: cmd === 'fav' }) }));
      if (flags.json) return console.log(JSON.stringify({ ok: true, results: result }, null, 2));
      return console.log(`${cmd === 'fav' ? 'favorited' : 'unfavorited'}: ${names.join(', ')}`);
    }

    case 'tag':
    case 'untag': {
      const tags = pos.slice(2);
      if (!name || !tags.length) throw new SkmError('invalid', `usage: skm ${cmd} <name> <tag...>`);
      const meta = updateMeta(opts, { name, [cmd === 'tag' ? 'addTags' : 'removeTags']: tags });
      if (flags.json) return console.log(JSON.stringify({ ok: true, meta }, null, 2));
      return console.log(`${name}: ${meta.tags.length ? meta.tags.join(', ') : 'no tags'}`);
    }

    case 'tags': {
      if (flags.json) return console.log(JSON.stringify(state.tags, null, 2));
      if (!state.tags.length) return console.log('no tags in use: add one with `skm tag <name> <tag>`');
      return console.log(table([['TAG', 'SKILLS'].map((h) => c.bold(h)), ...state.tags.map((t) => [t.tag, String(t.count)])]));
    }

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
      if (!name) throw new SkmError('invalid', `usage: skm ${cmd} <name${cmd === 'pull' ? '...' : ''}>`);
      const copy = { action: 'copyToLocal', scope: 'global', overwrite: Boolean(flags.overwrite), target: flags.target };
      const req =
        cmd === 'promote'
          ? { action: 'promote', scope: 'local', name, overwrite: Boolean(flags.overwrite) }
          : pos.length > 2 ? { ...copy, names: pos.slice(1) } : { ...copy, name };
      return perform(opts, req, flags, { destructive: Boolean(flags.overwrite) });
    }

    case 'delete': {
      if (!name) throw new SkmError('invalid', 'usage: skm delete <name>');
      return perform(opts, { action: 'delete', scope: resolveScope(state, name, flags), name }, flags, { destructive: true });
    }

    case 'cost': {
      const rows = listAll(state).filter((s) => flags.all || s.active).sort((x, y) => y.cost.listing - x.cost.listing || x.name.localeCompare(y.name));
      if (flags.json) return console.log(JSON.stringify({ skills: rows.map((s) => ({ name: s.name, scope: s.scope, active: s.active, cost: s.cost })), totals: state.totals }, null, 2));
      if (!rows.length) return console.log('no skills found');
      console.log(table([['SCOPE', 'NAME', 'LISTING', 'FULL'].map((h) => c.bold(h)), ...rows.map((s) => [s.scope, s.active ? s.name : c.dim(`${s.name} (inactive)`), String(s.cost.listing), String(s.cost.full)])]));
      const t = state.totals;
      console.log(`\n${t.global.active} global + ${t.local.active} local active skills: ~${t.listingTokens} tokens loaded in every session (global ${t.global.listingTokens}, local ${t.local.listingTokens})`);
      return console.log(c.dim('listing = name + description, full = whole SKILL.md; tokens are estimated as chars / 4'));
    }

    case 'lint': {
      const skills = listAll(state).filter((s) => (name ? s.name === name : flags.all || s.active));
      if (name && !skills.length) throw new SkmError('not-found', `no skill named "${name}"`);
      const bad = skills.filter((s) => s.lint.length);
      if (flags.json) console.log(JSON.stringify(bad.map((s) => ({ name: s.name, scope: s.scope, lint: s.lint })), null, 2));
      else if (!bad.length) console.log(c.green(`${skills.length} skill(s) checked, no findings`));
      else {
        const SEV = { error: c.red, warn: c.yellow, info: c.dim };
        for (const s of bad) {
          console.log(c.bold(`${s.scope}/${s.name}`));
          for (const f of s.lint) console.log(`  ${(SEV[f.severity] ?? ((x) => x))(f.severity.padEnd(5))} ${f.rule}: ${f.message}`);
        }
      }
      if (bad.some((s) => s.lint.some((f) => f.severity === 'error'))) process.exitCode = 1;
      return;
    }

    case 'diff': {
      if (!name) throw new SkmError('invalid', 'usage: skm diff <name>');
      const d = await diffUpstream(opts, name);
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      printDiff(d);
      return;
    }

    case 'outdated': {
      const check = await checkUpdates(opts);
      if (flags.json) return console.log(JSON.stringify(check, null, 2));
      const rows = state.global.filter((s) => check.results[s.name]).map((s) => {
        const r = check.results[s.name];
        return [s.name, s.origin.source, (CHECK_COLOR[r.status] ?? ((x) => x))(r.status) + (r.error ? c.dim(` (${r.error})`) : '') + (s.origin.modified ? c.yellow(' [modified]') : '')];
      });
      if (!rows.length) return console.log('no installed skill has a GitHub source in the skills lock file');
      return console.log(table([['NAME', 'SOURCE', 'STATUS'].map((h) => c.bold(h)), ...rows]));
    }

    case 'update': {
      if (!flags.all && !name) throw new SkmError('invalid', 'usage: skm update <name> | --all');
      const dryRun = Boolean(flags['dry-run']);
      const force = Boolean(flags.force);
      let names = [name];
      if (flags.all) {
        const { results } = await checkUpdates(opts);
        const due = state.global.filter((s) => results[s.name]?.status === 'update-available');
        names = due.filter((s) => force || !s.origin.modified).map((s) => s.name);
        for (const s of due) if (!names.includes(s.name)) console.log(c.yellow(`skipped ${s.name}: modified locally (use --force)`));
        if (!names.length) return console.log('nothing to update');
      }
      const plans = names.map((n) => runAction(opts, { action: 'update', scope: 'global', name: n, force, dryRun: true }));
      if (plans.every((p) => !p.changes.length)) return report(plans[0], flags);
      if (!dryRun) {
        for (const p of plans) for (const ch of p.changes) console.log(`  ${ch}`);
        if (process.stdin.isTTY && !flags.yes) {
          for (const n of names) {
            try {
              console.log(`  diff ${n}: ${statLine((await diffUpstream(opts, n)).stats)}  (skm diff ${n} for details; local edits show as removals)`);
            } catch {}
          }
        }
        const what = names.length === 1 ? names[0] : `${names.length} skills (${names.join(', ')})`;
        if (!(await confirm(`${what} will be replaced by the version from its source; the old version goes to the system Trash.\nContinue?`, flags))) return console.log('aborted');
      }
      const done = names.map((n) => runAction(opts, { action: 'update', scope: 'global', name: n, force, dryRun }));
      if (done.length === 1) return report(done[0], flags);
      return report({ ok: true, message: `${dryRun ? 'dry run: ' : ''}updated ${done.length} skill(s)`, changes: done.flatMap((r) => r.changes) }, flags);
    }

    case 'projects':
      return projectsCommand(opts, pos.slice(1), flags);

    case 'config': {
      const file = configPath(resolveContext(opts).home);
      console.log(file);
      return console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd() : c.dim('(no config file yet: defaults, no project roots)'));
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
