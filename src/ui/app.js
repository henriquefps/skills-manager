/* skm UI. Vanilla JS, no build step. Talks to the HTTP API in docs/ARCHITECTURE.md. */
(() => {
  'use strict';

  // ---------- constants ----------

  const STATUS = {
    'ok': { label: 'OK', tone: 'ok' },
    'needs-link': { label: 'Needs link', tone: 'warn' },
    'duplicate': { label: 'Duplicate', tone: 'warn' },
    'diverged': { label: 'Diverged', tone: 'bad' },
    'claude-only': { label: 'Claude only', tone: 'warn' },
    'broken-link': { label: 'Broken link', tone: 'bad' },
    'wrong-link': { label: 'Wrong link', tone: 'warn' },
    'empty': { label: 'Empty', tone: 'bad' },
    'conflict': { label: 'Conflict', tone: 'bad' },
  };
  const FIXABLE = new Set(['needs-link', 'duplicate', 'claude-only', 'wrong-link', 'broken-link', 'diverged']);
  const STATUS_ORDER = Object.keys(STATUS);

  const state = {
    data: null,
    scope: 'global',
    q: '',
    filter: 'all',
    busy: new Set(),
    loadError: null,
    updates: null, // { checkedAt, results } from GET /api/updates; null until the user runs a check
    checking: false,
    sort: 'name',
    projects: null, // GET /api/projects payload, loaded when the Projects tab is first opened
    config: null, // GET /api/config
    projectsLoading: false,
    projectsError: null,
    rootDraft: '',
  };

  const SCOPES = ['global', 'local', 'projects'];
  const SEVERITY = { error: { label: 'error', one: 'error', many: 'errors', tone: 'bad' }, warn: { label: 'warn', one: 'warning', many: 'warnings', tone: 'warn' }, info: { label: 'info', one: 'note', many: 'notes', tone: 'info' } };
  const SEV_ORDER = ['error', 'warn', 'info'];

  const UPDATE_STATUS = {
    'up-to-date': { label: 'Up to date', tone: 'ok' },
    'update-available': { label: 'Update available', tone: 'accent' },
    'removed-upstream': { label: 'Removed upstream', tone: 'plain' },
    'unreachable': { label: 'Check failed', tone: 'warn' },
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- helpers ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const key = (s) => `${s.scope}:${s.name}`;

  function shortPath(p) {
    const parts = p.replace(/^\/(Users|home)\/[^/]+/, '~').split('/');
    if (parts.length <= 4) return parts.join('/');
    return '.../' + parts.slice(-3).join('/');
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const fmtTok = (n) => Number(n || 0).toLocaleString('en-US');
  const baseName = (p) => p.replace(/\/+$/, '').split('/').pop();

  async function api(path, body, method) {
    const opts = body
      ? { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw Object.assign(new Error('Could not reach the skm server.'), { code: 'network' });
    }
    let json = null;
    try { json = await res.json(); } catch { /* handled below */ }
    if (!res.ok || (json && json.ok === false)) {
      throw Object.assign(new Error((json && json.error) || `Request failed (${res.status}).`), {
        code: json && json.code,
      });
    }
    return json;
  }

  // ---------- toasts ----------

  function toast(message, kind = 'info') {
    const box = $('#toasts');
    const t = h('div', { class: `toast ${kind}` },
      h('span', { text: message }),
      h('button', { type: 'button', 'aria-label': 'Dismiss message', text: 'Close', onclick: () => t.remove() }));
    box.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 9000 : 5000);
  }

  // ---------- state loading ----------

  async function refresh() {
    try {
      state.data = await api('/api/state');
      state.loadError = null;
    } catch (e) {
      state.loadError = e.message;
    }
    render();
    if (state.projects) await loadProjects();
  }

  const resultOf = (s) => (state.updates && s.scope === 'global' && s.origin ? state.updates.results[s.name] || null : null);
  const hasUpdate = (s) => { const r = resultOf(s); return !!r && r.status === 'update-available'; };
  const hasLint = (s) => !!(s.lint && s.lint.length);
  const isModified = (s) => !!(s.origin && s.origin.modified);

  const skillsOf = (scope) => (state.data ? state.data[scope] || [] : []);
  const problems = (skills) => skills.filter((s) => s.status !== 'ok');
  const fixAllTargets = () => skillsOf('global').filter((s) => FIXABLE.has(s.status) && s.status !== 'diverged');

  // ---------- rendering ----------

  function render() {
    const focusKey = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.fk : null;
    renderHeader();
    renderCost();
    renderCheckBar();
    renderBanner();
    renderUpdatesBanner();
    renderTabs();
    renderChips();
    renderList();
    if (focusKey) {
      const el = document.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`);
      if (el) el.focus();
    }
  }

  function renderHeader() {
    const d = state.data;
    if (!d) {
      $('#deck').textContent = state.loadError || 'Loading your skills.';
      return;
    }
    $('#title').textContent = d.project ? d.project.name : 'Your skills';
    $('#deck').textContent = d.project
      ? 'Skills your agents can use here, from your home folder and from this project.'
      : 'Skills your agents can use from your home folder. No project was detected in this folder.';
    $('#cwd').textContent = d.cwd || '';
    document.title = `${d.project ? d.project.name : 'Skills'} - skm`;
  }

  function totalsOf(d) {
    if (d.totals) return d.totals;
    const tot = (list) => {
      const on = list.filter((x) => x.active);
      return { active: on.length, listingTokens: on.reduce((n, x) => n + (x.cost ? x.cost.listing : 0), 0) };
    };
    const t = { global: tot(d.global), local: tot(d.local) };
    t.listingTokens = t.global.listingTokens + t.local.listingTokens;
    return t;
  }

  function renderCost() {
    const el = $('#coststat');
    const d = state.data;
    el.hidden = !d;
    if (!d) return;
    const t = totalsOf(d);
    const active = t.global.active + t.local.active;
    el.replaceChildren(
      h('p', { class: 'cost-line' },
        'About ', h('strong', { text: fmtTok(t.listingTokens) }), ` tokens of context loaded by ${active} active ${active === 1 ? 'skill' : 'skills'}.`),
      h('p', { class: 'cost-note' },
        `Estimate, not exact: characters divided by 4, counting each skill's name and description, which every session loads up front. Global ${fmtTok(t.global.listingTokens)}, local ${fmtTok(t.local.listingTokens)}. A skill's full SKILL.md loads only when it is used.`));
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function renderCheckBar() {
    const bar = $('#checkbar');
    bar.hidden = !state.data || state.scope !== 'global';
    const btn = $('#check-btn');
    btn.disabled = state.checking;
    btn.setAttribute('aria-busy', String(state.checking));
    btn.replaceChildren(...[
      state.checking ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
      state.checking ? 'Checking' : state.updates ? 'Check again' : 'Check for updates'].filter(Boolean));
    const meta = $('#check-meta');
    if (state.checking) meta.textContent = 'Asking GitHub for the latest version of each source. This can take a few seconds.';
    else if (state.updates) {
      meta.replaceChildren('Last checked ', h('time', { datetime: state.updates.checkedAt, title: new Date(state.updates.checkedAt).toLocaleString(), text: fmtTime(state.updates.checkedAt) }));
    } else meta.textContent = 'Runs only when you ask. Compares installed skills with their source on GitHub.';
  }

  async function checkUpdates() {
    if (state.checking) return;
    state.checking = true;
    render();
    try {
      state.updates = await api('/api/updates');
      const n = skillsOf('global').filter(hasUpdate).length;
      toast(n ? `${n} ${n === 1 ? 'update' : 'updates'} available.` : 'Everything tracked is up to date.');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      state.checking = false;
      render();
    }
  }

  function renderUpdatesBanner() {
    const el = $('#updates-banner');
    if (!state.data || !state.updates || state.scope !== 'global') { el.hidden = true; return; }
    const n = skillsOf('global').filter(hasUpdate).length;
    const failed = Object.values(state.updates.results).filter((r) => r.status === 'unreachable').length;
    el.hidden = false;
    el.replaceChildren();
    el.className = `banner updates${n ? ' problems' : ''}`;
    const note = failed ? ` ${failed} ${failed === 1 ? 'source' : 'sources'} could not be checked.` : '';
    el.append(
      h('div', {},
        h('h2', { text: n ? `${n} ${n === 1 ? 'update' : 'updates'} available` : 'No updates available' }),
        h('p', { text: (n ? 'Upstream has newer versions of these skills. Each update asks for confirmation first.' : 'Every checked skill matches its source.') + note })),
      n && state.filter !== 'update'
        ? h('button', { class: 'btn', type: 'button', 'data-fk': 'show-updates', text: 'Show them', onclick: () => { state.filter = 'update'; render(); } })
        : '');
  }

  function renderBanner() {
    const el = $('#banner');
    if (!state.data || state.scope === 'projects') { el.hidden = true; return; }
    const bad = problems(skillsOf('global'));
    const localBad = problems(skillsOf('local'));
    const fixable = fixAllTargets();
    el.hidden = false;
    el.replaceChildren();
    if (!bad.length && !localBad.length) {
      el.className = 'banner';
      el.append(h('div', {},
        h('h2', { text: 'Everything is in order' }),
        h('p', { text: 'Every skill is linked and consistent.' })));
      return;
    }
    el.className = 'banner problems';
    const manual = bad.length - fixable.length;
    const parts = [];
    if (fixable.length) parts.push(`${fixable.length} can be fixed automatically`);
    if (manual) parts.push(`${manual} global ${manual === 1 ? 'needs' : 'need'} a manual decision`);
    if (localBad.length) parts.push(`${localBad.length} local ${localBad.length === 1 ? 'has' : 'have'} problems`);
    const total = bad.length + localBad.length;
    el.append(
      h('div', {},
        h('h2', { text: `${total} ${total === 1 ? 'skill needs' : 'skills need'} attention` }),
        h('p', { text: parts.join('. ') + '.' })),
      fixable.length
        ? h('button', { class: 'btn primary', type: 'button', onclick: fixAll, 'data-fk': 'fixall', text: `Fix all (${fixable.length})` })
        : '');
  }

  function renderTabs() {
    const d = state.data;
    $('#count-global').textContent = d ? d.global.length : 0;
    $('#count-local').textContent = d ? d.local.length : 0;
    const pc = $('#count-projects');
    pc.hidden = !state.projects;
    pc.textContent = state.projects ? state.projects.projects.length : 0;
    const proj = state.scope === 'projects';
    $('#chips').hidden = proj;
    $('#sort-box').hidden = proj;
    $('#sort').value = state.sort;
    $('.toolbar').classList.toggle('no-sort', proj);
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.scope === state.scope;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    $('#list').setAttribute('aria-labelledby', `tab-${state.scope}`);
  }

  function chipDefs(skills) {
    const defs = [
      { id: 'all', label: 'All', n: skills.length },
      { id: 'problems', label: 'Needs attention', n: problems(skills).length },
      { id: 'active', label: 'Active', n: skills.filter((s) => s.active).length },
      { id: 'inactive', label: 'Inactive', n: skills.filter((s) => !s.active).length },
      { id: 'lint', label: 'Lint issues', n: skills.filter(hasLint).length },
    ];
    if (state.updates && skills.length && skills[0].scope === 'global') {
      defs.push({ id: 'update', label: 'Update available', n: skills.filter(hasUpdate).length });
      defs.push({ id: 'modified', label: 'Modified', n: skills.filter(isModified).length });
    }
    for (const st of STATUS_ORDER) {
      if (st === 'ok') continue;
      const n = skills.filter((s) => s.status === st).length;
      if (n) defs.push({ id: `status:${st}`, label: STATUS[st].label, n });
    }
    return defs;
  }

  function matchesFilter(s) {
    const f = state.filter;
    if (f === 'all') return true;
    if (f === 'problems') return s.status !== 'ok';
    if (f === 'active') return s.active;
    if (f === 'inactive') return !s.active;
    if (f === 'lint') return hasLint(s);
    if (f === 'update') return hasUpdate(s);
    if (f === 'modified') return isModified(s);
    if (f.startsWith('status:')) return s.status === f.slice(7);
    return true;
  }

  function renderChips() {
    const box = $('#chips');
    const defs = chipDefs(skillsOf(state.scope));
    const cur = defs.find((c) => c.id === state.filter);
    if (!cur || (state.filter === 'update' && !cur.n)) state.filter = 'all';
    box.replaceChildren(...defs.map((c) =>
      h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(c.id === state.filter), 'data-fk': `chip:${c.id}`,
        onclick: () => { state.filter = c.id; render(); },
      }, c.label, ' ', h('span', { class: 'n', text: c.n }))));
  }

  function renderList() {
    const list = $('#list');
    list.replaceChildren();
    if (!state.data) {
      list.append(emptyState(state.loadError ? 'Could not load skills' : 'Loading', state.loadError || 'One moment.'));
      return;
    }
    if (state.scope === 'projects') { renderProjects(list); return; }
    if (state.scope === 'local' && !state.data.project) {
      list.append(emptyState('No project here',
        'Local skills live inside a project folder. Run skm from a folder that has .git, .agents or .claude to manage them.'));
      return;
    }
    const all = skillsOf(state.scope);
    const q = state.q.trim().toLowerCase();
    const shown = all
      .filter(matchesFilter)
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q))
      .sort((a, b) => (state.sort === 'cost' ? costOf(b) - costOf(a) : 0) || a.name.localeCompare(b.name));
    const maxCost = Math.max(1, ...all.map(costOf));
    if (!shown.length) {
      list.append(all.length
        ? emptyState('No matching skills', 'Try a different search or clear the status filter.')
        : emptyState(state.scope === 'local' ? 'No local skills yet' : 'No global skills yet',
          state.scope === 'local'
            ? 'Copy a global skill into this project to see it here.'
            : 'Promote a local skill to make it available everywhere.'));
      return;
    }
    list.append(...shown.map((s) => card(s, maxCost)));
  }

  function emptyState(title, text) {
    return h('div', { class: 'empty-state' }, h('h2', { text: title }), h('p', { text }));
  }

  function badge(status) {
    const m = STATUS[status] || { label: status, tone: 'plain' };
    return h('span', { class: `badge ${m.tone}`, text: m.label });
  }

  function updateBadge(r) {
    const m = UPDATE_STATUS[r.status];
    if (!m) return null;
    const tip = r.status === 'removed-upstream' ? 'This folder no longer exists in the source repository. It may have been renamed or deleted.'
      : r.status === 'unreachable' ? `Check failed: ${r.error || 'unknown error'}` : null;
    return h('span', { class: `badge ${m.tone}`, title: tip }, m.label);
  }

  function originBlock(s) {
    const o = s.origin;
    if (!o) return null;
    const r = resultOf(s);
    const note = !r ? null
      : r.status === 'removed-upstream' ? `No longer in ${o.source}. It may have been renamed or deleted, so it cannot be updated.`
      : r.status === 'unreachable' ? `Check failed: ${r.error || 'unknown error'}.`
      : null;
    return h('div', { class: 'origin' },
      h('div', { class: 'origin-line' },
        h('span', { class: 'repo', title: o.url || o.source }, o.source),
        h('span', { class: 'meta', text: `Installed ${fmtDate(o.installedAt)}` }),
        o.updatedAt && o.updatedAt !== o.installedAt ? h('span', { class: 'meta', text: `Updated ${fmtDate(o.updatedAt)}` }) : null),
      note ? h('p', { class: `origin-note${r.status === 'unreachable' ? ' warn' : ''}`, text: note }) : null);
  }

  const costOf = (s) => (s.cost ? s.cost.listing : 0);

  function costTitle(s) {
    const c = s.cost || { listing: 0, full: 0 };
    return `Listing: about ${fmtTok(c.listing)} tokens (name and description, loaded every session while active). Full SKILL.md: about ${fmtTok(c.full)} tokens (loaded when the skill is used). Estimates.`;
  }

  function costBadge(s) {
    if (!s.cost) return null;
    return h('span', { class: 'badge cost', title: costTitle(s) }, `~${fmtTok(s.cost.listing)} tok`);
  }

  function lintCounts(lint) {
    const c = { error: 0, warn: 0, info: 0 };
    for (const f of lint || []) if (c[f.severity] != null) c[f.severity] += 1;
    return c;
  }

  function lintBadges(s) {
    const c = lintCounts(s.lint);
    const tip = (s.lint || []).map((f) => `${f.severity}: ${f.message}`).join('\n');
    return SEV_ORDER.filter((sv) => c[sv]).map((sv) =>
      h('span', { class: `badge lint ${SEVERITY[sv].tone}`, title: tip, 'aria-label': `${c[sv]} lint ${c[sv] === 1 ? SEVERITY[sv].one : SEVERITY[sv].many}` },
        `${c[sv]} ${SEVERITY[sv].label}`));
  }

  function card(s, maxCost = 1) {
    const k = key(s);
    const other = s.scope === 'global' ? 'local' : 'global';
    const has = (scope) => (s.alsoIn || []).includes(scope);
    const canNormalize = s.scope === 'global' && FIXABLE.has(s.status);

    const el = h('article', { class: `card${s.active ? '' : ' inactive'}${state.busy.has(k) ? ' busy' : ''}`, 'aria-labelledby': `n-${k}` },
      h('div', { class: 'card-top' },
        h('div', { class: 'card-id' },
          h('h3', { class: 'name', id: `n-${k}`, text: s.name }),
          h('div', { class: 'badges' },
            badge(s.status),
            !s.active ? h('span', { class: 'badge plain', text: 'Inactive' }) : null,
            costBadge(s),
            lintBadges(s),
            has(other) ? h('span', { class: 'badge also', text: `Also ${other}` }) : null,
            resultOf(s) ? updateBadge(resultOf(s)) : null,
            isModified(s) ? h('span', { class: 'badge warn', title: 'The files differ from the version that was installed.', text: 'Modified locally' }) : null)),
        h('button', {
          class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(s.active),
          'aria-label': `${s.active ? 'Deactivate' : 'Activate'} ${s.name}`, 'data-fk': `sw:${k}`,
          title: s.active ? 'Active. Click to deactivate.' : 'Inactive. Click to activate.',
          onclick: () => toggle(s),
        })),
      h('p', { class: `desc${s.description ? '' : ' empty'}`, text: s.description || 'No description in SKILL.md.' }),
      s.cost ? h('div', { class: `costbar${s.active ? '' : ' off'}`, 'aria-hidden': 'true', title: costTitle(s) }, h('i', { style: `width:${Math.max(2, Math.round((costOf(s) / maxCost) * 100))}%` })) : null,
      originBlock(s),
      s.issues && s.issues.length ? h('ul', { class: `issues${STATUS[s.status] && STATUS[s.status].tone === 'bad' ? ' bad' : ''}` }, s.issues.map((i) => h('li', { text: i }))) : null,
      h('div', { class: 'paths' }, (s.locations || []).map((l) =>
        h('span', { class: `path${l.kind === 'broken-symlink' ? ' broken' : ''}${l.kind !== 'dir' ? ' link' : ''}`, title: l.target ? `${l.path} -> ${l.target}` : l.path },
          h('b', { text: l.root }),
          h('span', { text: shortPath(l.path) }),
          l.kind !== 'dir' ? h('i', { text: l.kind === 'broken-symlink' ? 'broken link' : 'link', style: 'font-style:normal;opacity:.7' }) : null))),
      h('div', { class: 'card-foot' },
        h('span', { class: 'meta', text: `${s.files} ${s.files === 1 ? 'file' : 'files'} / ${fmtBytes(s.bytes)} / ${fmtDate(s.mtime)}` }),
        h('div', { class: 'actions' },
          s.scope === 'local' ? h('button', { class: 'btn small', type: 'button', text: 'Promote to global', onclick: () => promote(s) }) : null,
          s.scope === 'global' && state.data.project ? h('button', { class: 'btn small', type: 'button', text: 'Copy to local', onclick: () => copyToLocal(s) }) : null,
          hasUpdate(s) ? h('button', { class: 'btn small primary', type: 'button', text: 'Update', 'data-fk': `up:${k}`, 'aria-label': `Update ${s.name}`, onclick: () => updateSkill(s) }) : null,
          canNormalize ? h('button', { class: 'btn small', type: 'button', text: 'Normalize', onclick: () => normalize(s) }) : null,
          h('button', { class: 'btn small', type: 'button', text: 'Details', 'data-fk': `d:${k}`, onclick: () => openDetails(s) }),
          h('button', { class: 'btn small danger', type: 'button', text: 'Delete', onclick: () => remove(s) }))));
    return el;
  }

  // ---------- confirm dialog ----------

  /**
   * Opens the confirm dialog. `options` render as radios/checkboxes whose values are passed to
   * `preview(values)` (a dry run) every time they change. Resolves with the values, or null.
   */
  function confirmDialog({ title, lead = '', confirmLabel = 'Confirm', danger = false, options = [], preview, extra }) {
    const dlg = $('#confirm');
    const optBox = $('#confirm-options');
    const prev = $('#confirm-preview');
    const ok = $('#confirm-ok');
    $('#confirm-title').textContent = title;
    $('#confirm-lead').textContent = lead;
    ok.textContent = confirmLabel;
    ok.className = `btn primary${danger ? ' danger solid' : ''}`;
    optBox.replaceChildren();
    const extraBox = $('#confirm-extra');
    extraBox.replaceChildren();
    dlg.classList.toggle('wide', !!extra);

    const values = {};
    const radios = new Map();
    for (const o of options) {
      if (o.type === 'select') {
        values[o.name] = o.value ?? o.choices[0].value;
        const sel = h('select', { name: o.name, 'aria-label': o.label }, o.choices.map((c) => h('option', { value: c.value, text: c.label })));
        sel.value = values[o.name];
        sel.addEventListener('change', () => { values[o.name] = sel.value; runPreview(); });
        optBox.append(h('label', { class: 'opt select' }, h('span', {}, h('strong', { text: o.label }), o.hint ? h('small', { text: o.hint }) : null), sel));
        continue;
      }
      if (o.type === 'radio') {
        if (o.checked) values[o.name] = o.value;
      } else {
        values[o.name] = !!o.checked;
      }
      const input = h('input', { type: o.type, name: o.name, value: o.value ?? '', checked: o.checked ? true : null });
      input.addEventListener('change', () => {
        values[o.name] = o.type === 'radio' ? o.value : input.checked;
        runPreview();
      });
      radios.set(input, o);
      optBox.append(h('label', { class: 'opt' }, input, h('span', {}, h('strong', { text: o.label }), o.hint ? h('small', { text: o.hint }) : null)));
    }

    let seq = 0;
    async function runPreview() {
      const mine = ++seq;
      ok.disabled = true;
      prev.replaceChildren(h('p', { class: 'muted', text: 'Checking what would change.' }));
      let res;
      try { res = await preview({ ...values }); } catch (e) { res = { error: e.message }; }
      if (mine !== seq) return;
      prev.replaceChildren(renderPreview(res));
      ok.disabled = !!res.error || !!res.blocked;
    }

    function loadExtra() {
      extraBox.replaceChildren(h('p', { class: 'muted', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Loading the diff.'));
      extra().then((node) => extraBox.replaceChildren(node)).catch((e) => extraBox.replaceChildren(
        h('div', { class: 'extra-error', role: 'alert' },
          h('p', { text: `Could not load the diff: ${e.message}` }),
          h('button', { class: 'btn small', type: 'button', text: 'Try again', onclick: loadExtra }))));
    }

    return new Promise((resolve) => {
      let result = null;
      const onSubmit = (e) => { e.preventDefault(); result = { ...values }; dlg.close(); };
      const onCancel = () => dlg.close();
      const onClose = () => {
        $('#confirm-form').removeEventListener('submit', onSubmit);
        $('#confirm-cancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        resolve(result);
      };
      $('#confirm-form').addEventListener('submit', onSubmit);
      $('#confirm-cancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      if (extra) loadExtra();
      runPreview();
      const first = optBox.querySelector('input:checked') || $('#confirm-cancel');
      first.focus();
    });
  }

  function renderPreview(res) {
    if (res.error) {
      return h('ul', {}, h('li', { class: 'err', text: res.error }));
    }
    const lines = res.lines || (res.changes || []).map((c) => ({ text: c }));
    if (!lines.length) return h('p', { class: 'muted', text: 'Nothing would change.' });
    return h('ul', {}, lines.map((l) => h('li', { class: l.group ? 'group' : l.error ? 'err' : '', text: l.text })));
  }

  const dry = (payload) => api('/api/action', { ...payload, dryRun: true });

  // ---------- actions ----------

  async function perform(skill, payload, { quiet = false, busyKey = null } = {}) {
    const k = busyKey || (skill ? key(skill) : null);
    if (k) { state.busy.add(k); render(); }
    try {
      const res = await api('/api/action', payload);
      if (!quiet) toast(res.message || 'Done.');
      return res;
    } catch (e) {
      toast(e.message, 'error');
      return null;
    } finally {
      if (k) state.busy.delete(k);
      if (!quiet) await refresh();
    }
  }

  async function toggle(s) {
    await perform(s, { action: s.active ? 'deactivate' : 'activate', scope: s.scope, name: s.name });
  }

  async function promote(s, projectRoot) {
    const base = { action: 'promote', scope: 'local', name: s.name, ...(projectRoot ? { projectRoot } : {}) };
    const exists = (s.alsoIn || []).includes('global');
    const values = await confirmDialog({
      title: `Promote ${s.name} to global`,
      lead: 'Copies this skill to your global store and links it for Claude. The local copy stays.',
      confirmLabel: 'Promote',
      options: [{ type: 'checkbox', name: 'overwrite', label: 'Overwrite the global copy', hint: 'A global skill with this name already exists.', checked: false }]
        .filter(() => exists),
      preview: async (v) => previewOf(await safeDry({ ...base, overwrite: !!v.overwrite })),
    });
    if (values) await perform(projectRoot ? null : s, { ...base, overwrite: !!values.overwrite }, { busyKey: projectRoot ? pkey(projectRoot, s.name) : null });
  }

  async function copyToLocal(s) {
    const base = { action: 'copyToLocal', scope: 'global', name: s.name };
    const exists = (s.alsoIn || []).includes('local');
    const options = [
      { type: 'radio', name: 'target', value: 'claude', label: 'Into .claude/skills', hint: 'Visible to Claude in this project.', checked: true },
      { type: 'radio', name: 'target', value: 'agents', label: 'Into .agents/skills', hint: 'Shared with other agents in this project.' },
    ];
    if (exists) options.push({ type: 'checkbox', name: 'overwrite', label: 'Overwrite the local copy', hint: 'A local skill with this name already exists.', checked: false });
    const values = await confirmDialog({
      title: `Copy ${s.name} to local`,
      lead: 'Copies the skill into this project. The global copy stays.',
      confirmLabel: 'Copy',
      options,
      preview: async (v) => previewOf(await safeDry({ ...base, target: v.target, overwrite: !!v.overwrite })),
    });
    if (values) await perform(s, { ...base, target: values.target, overwrite: !!values.overwrite });
  }

  async function normalize(s) {
    const base = { action: 'normalize', scope: 'global', name: s.name };
    const diverged = s.status === 'diverged';
    const options = diverged ? [
      { type: 'radio', name: 'keep', value: 'agents', label: 'Keep the agents version', hint: 'The Claude copy is replaced by a link.', checked: true },
      { type: 'radio', name: 'keep', value: 'claude', label: 'Keep the Claude version', hint: 'It replaces the agents copy, then gets linked.' },
    ] : [];
    const values = await confirmDialog({
      title: `Normalize ${s.name}`,
      lead: diverged
        ? 'The agents and Claude folders have different contents. Choose which side wins.'
        : 'Makes the agents folder canonical and links it for Claude.',
      confirmLabel: 'Normalize',
      options,
      preview: async (v) => previewOf(await safeDry({ ...base, ...(diverged ? { keep: v.keep } : {}) })),
    });
    if (values) await perform(s, { ...base, ...(diverged ? { keep: values.keep } : {}) });
  }

  async function updateSkill(s) {
    const modified = isModified(s);
    const base = { action: 'update', scope: 'global', name: s.name };
    const values = await confirmDialog({
      title: `Update ${s.name}`,
      lead: `Replaces the installed copy with the latest version from ${s.origin.source}. The old version goes to the system Trash.`
        + (modified ? ' This skill has local edits. They will be replaced, and they are only kept in the Trash copy.' : ''),
      confirmLabel: modified ? 'Update anyway' : 'Update',
      danger: modified,
      preview: async () => previewOf(await safeDry({ ...base, force: modified })),
      extra: async () => diffView(await api(`/api/diff?name=${encodeURIComponent(s.name)}`), modified),
    });
    if (!values) return;
    const k = key(s);
    state.busy.add(k);
    render();
    try {
      const res = await api('/api/action', { ...base, force: modified });
      toast(res.message || `Updated ${s.name}.`);
      if (state.updates) state.updates.results[s.name] = { status: 'up-to-date' };
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      state.busy.delete(k);
      await refresh();
    }
  }

  async function remove(s) {
    const base = { action: 'delete', scope: s.scope, name: s.name };
    // The destination comes from the dry-run plan, so the lead names the exact place.
    const dry = await safeDry(base);
    const dests = ((dry && dry.changes) || []).map((ch) => /^trash .+? -> (.+)$/.exec(ch)).filter(Boolean).map((m) => m[1]);
    const where = dests.length ? ` (${dests.join(', ')})` : '';
    const ok = await confirmDialog({
      title: `Delete ${s.name}`,
      lead: `${s.name} will be removed from ${s.scope} and moved to the system Trash${where}. To get it back, restore it from the Trash by hand.`,
      confirmLabel: 'Move to Trash',
      danger: true,
      preview: async () => previewOf(dry),
    });
    if (ok) await perform(s, base);
  }

  async function fixAll() {
    const targets = fixAllTargets();
    const diverged = skillsOf('global').filter((s) => s.status === 'diverged');
    const ok = await confirmDialog({
      title: `Fix ${targets.length} global ${targets.length === 1 ? 'skill' : 'skills'}`,
      lead: diverged.length
        ? `Normalizes every fixable skill. ${diverged.length} diverged ${diverged.length === 1 ? 'skill is' : 'skills are'} skipped because they need a choice.`
        : 'Normalizes every fixable global skill.',
      confirmLabel: 'Fix all',
      preview: async () => {
        const lines = [];
        let failed = false;
        for (const s of targets) {
          lines.push({ text: s.name, group: true });
          try {
            const r = await dry({ action: 'normalize', scope: 'global', name: s.name });
            const ch = r.changes || [];
            if (!ch.length) lines.push({ text: 'No changes.' });
            ch.forEach((c) => lines.push({ text: c }));
          } catch (e) {
            failed = true;
            lines.push({ text: e.message, error: true });
          }
        }
        return { lines, blocked: false, failed };
      },
    });
    if (!ok) return;
    let done = 0;
    let failed = 0;
    for (const s of targets) {
      const r = await perform(s, { action: 'normalize', scope: 'global', name: s.name }, { quiet: true });
      if (r) done += 1; else failed += 1;
    }
    toast(`Normalized ${done} ${done === 1 ? 'skill' : 'skills'}${failed ? `, ${failed} failed` : ''}.`, failed ? 'error' : 'info');
    await refresh();
  }

  async function safeDry(payload) {
    try { return await dry(payload); } catch (e) { return { error: e.message }; }
  }
  const previewOf = (r) => r;

  // ---------- update diff ----------

  const FILE_STATUS = { added: { label: 'Added', tone: 'accent' }, removed: { label: 'Removed', tone: 'bad' }, modified: { label: 'Modified', tone: 'plain' } };

  function diffView(d, modified) {
    const st = d.stats || {};
    const files = d.files || [];
    const parts = [['modified', st.modified], ['added', st.added], ['removed', st.removed]].filter(([, n]) => n);
    const wrap = h('div', { class: 'diff' },
      h('p', { class: 'diff-stats' },
        h('strong', { text: files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'} changed` : 'No differences' }),
        parts.length ? ` (${parts.map(([k, n]) => `${n} ${k}`).join(', ')})` : '',
        d.from && d.to ? h('span', { class: 'diff-rev', text: `${d.from} to ${d.to}` }) : null,
        h('span', { class: 'diff-counts' }, h('i', { class: 'add', text: `+${st.insertions || 0}` }), ' ', h('i', { class: 'del', text: `-${st.deletions || 0}` }))),
      h('p', { class: `diff-note${modified ? ' strong' : ''}`, text: modified
        ? 'This compares your installed copy with the latest upstream, so your local edits appear as removed lines and will be replaced.'
        : 'This compares your installed copy with the latest upstream. Anything you changed locally would appear as removed lines.' }));
    if (!files.length) return wrap;
    wrap.append(h('div', { class: 'diff-files' }, files.map((f, i) => diffFile(f, i === 0))));
    return wrap;
  }

  function diffFile(f, open) {
    const m = FILE_STATUS[f.status] || FILE_STATUS.modified;
    let add = 0;
    let del = 0;
    for (const hk of f.hunks || []) for (const l of hk.lines) { if (l[0] === '+') add += 1; else if (l[0] === '-') del += 1; }
    const body = f.binary
      ? h('p', { class: 'diff-binary', text: 'Binary file, contents not shown.' })
      : h('div', { class: 'dcode', tabindex: '0', role: 'region', 'aria-label': `Changes in ${f.path}` }, (f.hunks || []).map(diffHunk));
    return h('details', { class: 'dfile', open: open ? true : null },
      h('summary', {},
        h('span', { class: 'dpath', text: f.path }),
        h('span', { class: `badge ${m.tone}`, text: m.label }),
        f.binary ? h('span', { class: 'badge plain', text: 'Binary' }) : h('span', { class: 'diff-counts' }, h('i', { class: 'add', text: `+${add}` }), ' ', h('i', { class: 'del', text: `-${del}` }))),
      body);
  }

  function diffHunk(hk) {
    let o = hk.oldStart;
    let n = hk.newStart;
    return h('div', { class: 'dhunk' },
      h('div', { class: 'dhead', text: `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@` }),
      hk.lines.map((l) => {
        const c = l[0];
        const row = h('div', { class: `dl ${c === '+' ? 'add' : c === '-' ? 'del' : 'ctx'}` },
          h('span', { class: 'ln', 'aria-hidden': 'true', text: c === '+' ? '' : o }),
          h('span', { class: 'ln', 'aria-hidden': 'true', text: c === '-' ? '' : n }),
          h('span', { class: 'tx', text: l }));
        if (c !== '+') o += 1;
        if (c !== '-') n += 1;
        return row;
      }));
  }

  // ---------- details drawer ----------

  async function openDetails(s) {
    const dlg = $('#drawer');
    const closeBtn = h('button', { class: 'btn small ghost', type: 'button', text: 'Close', onclick: () => dlg.close() });
    const head = h('div', { class: 'drawer-head' },
      h('div', {},
        h('div', { class: 'badges' }, badge(s.status), h('span', { class: 'badge plain', text: s.scope }), !s.active ? h('span', { class: 'badge plain', text: 'Inactive' }) : null),
        h('h2', { id: 'drawer-title', text: s.name })),
      closeBtn);
    const body = h('div', { class: 'drawer-body' }, h('div', { class: 'loading', text: 'Loading SKILL.md.' }));
    dlg.replaceChildren(h('div', { class: 'drawer-inner' }, head, body));
    if (!dlg.open) dlg.showModal();
    closeBtn.focus();

    try {
      const r = await api(`/api/skill?scope=${encodeURIComponent(s.scope)}&name=${encodeURIComponent(s.name)}`);
      const sk = r.skill || s;
      body.replaceChildren(...[
        sk.description ? h('p', { class: 'deck', text: sk.description }) : null,
        h('div', { class: 'facts' },
          fact(sk.files, sk.files === 1 ? 'file' : 'files'),
          fact(fmtBytes(sk.bytes), 'size'),
          fact(fmtDate(sk.mtime) || 'unknown', 'modified'),
          sk.cost ? fact(`~${fmtTok(sk.cost.listing)}`, 'listing tokens') : null,
          sk.cost ? fact(`~${fmtTok(sk.cost.full)}`, 'full tokens') : null),
        sk.cost ? h('p', { class: 'meta', text: 'Token counts are estimates (characters divided by 4). The listing is loaded every session while the skill is active; the full SKILL.md loads when it is used.' }) : null,
        h('div', {}, h('h3', { class: 'section-label', text: 'Lint' }), lintList(sk.lint || [])),
        sk.issues && sk.issues.length ? h('div', {}, h('h3', { class: 'section-label', text: 'Issues' }), h('ul', { class: 'issues bad' }, sk.issues.map((i) => h('li', { text: i })))) : null,
        h('div', {}, h('h3', { class: 'section-label', text: 'Locations' }),
          h('div', { class: 'paths' }, (sk.locations || []).map((l) =>
            h('span', { class: `path${l.kind === 'broken-symlink' ? ' broken' : ''}`, title: l.path },
              h('b', { text: l.root }), h('span', { text: l.path }), l.target ? h('span', { text: `-> ${l.target}` }) : null)))),
        h('div', {}, h('h3', { class: 'section-label', text: 'Files' }),
          r.tree && r.tree.length ? h('ul', { class: 'tree' }, r.tree.map((f) => h('li', { text: f }))) : h('p', { class: 'meta', text: 'No files.' })),
        h('div', {}, h('h3', { class: 'section-label', text: 'SKILL.md' }),
          h('pre', { class: 'md', tabindex: '0', 'aria-label': 'SKILL.md contents', text: r.markdown || '(empty)' }))].filter(Boolean));
    } catch (e) {
      body.replaceChildren(h('p', { class: 'issues bad', text: e.message }));
    }
  }

  function lintList(lint) {
    if (!lint.length) return h('p', { class: 'meta', text: 'No findings.' });
    const sorted = [...lint].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
    return h('ul', { class: 'lint-list' }, sorted.map((f) => h('li', {},
      h('span', { class: `badge lint ${(SEVERITY[f.severity] || SEVERITY.info).tone}`, text: f.severity }),
      h('div', {}, h('code', { text: f.rule }), h('p', { text: f.message })))));
  }

  const fact = (value, label) => h('div', { class: 'fact' }, h('b', { text: value }), h('span', { text: label }));

  // ---------- projects ----------

  const pkey = (root, name) => `p:${root}:${name}`;

  async function loadProjects() {
    state.projectsLoading = true;
    state.projectsError = null;
    if (state.scope === 'projects') render();
    try {
      state.config = await api('/api/config');
      state.projects = state.config.projectRoots.length
        ? await api('/api/projects')
        : { roots: [], projects: [], repeated: [] };
    } catch (e) {
      state.projectsError = e.message;
    } finally {
      state.projectsLoading = false;
      render();
    }
  }

  async function saveConfig(next, okMessage) {
    try {
      state.config = await api('/api/config', next, 'PUT');
      if (okMessage) toast(okMessage);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }

  async function addRoot(path) {
    const p = path.trim();
    if (!p) { toast('Type a folder path first.', 'error'); return; }
    const cfg = state.config || { projectRoots: [], scanDepth: 3 };
    if (cfg.projectRoots.includes(p)) { toast('That folder is already in the list.', 'error'); return; }
    if (await saveConfig({ ...cfg, projectRoots: [...cfg.projectRoots, p] }, `Added ${p}.`)) {
      state.rootDraft = '';
      await loadProjects();
    }
  }

  async function removeRoot(path) {
    const cfg = state.config;
    if (await saveConfig({ ...cfg, projectRoots: cfg.projectRoots.filter((r) => r !== path) }, `Removed ${path} from the scan folders.`)) await loadProjects();
  }

  async function setDepth(n) {
    if (await saveConfig({ ...state.config, scanDepth: n })) await loadProjects();
  }

  function rootForm(first) {
    const input = h('input', {
      type: 'text', id: 'root-input', name: 'root', placeholder: '~/code or /Users/you/projects', autocomplete: 'off', spellcheck: 'false',
      value: state.rootDraft, 'data-fk': 'root-input',
      oninput: (e) => { state.rootDraft = e.target.value; },
    });
    return h('form', { class: 'rootform', onsubmit: (e) => { e.preventDefault(); addRoot(state.rootDraft); } },
      h('label', { class: 'sr', for: 'root-input', text: 'Folder path to scan for projects' }),
      input,
      h('button', { class: `btn${first ? ' primary' : ''}`, type: 'submit', 'data-fk': 'root-add', text: 'Add folder' }));
  }

  function renderProjects(list) {
    if (state.projectsError && !state.projects) {
      list.append(h('div', { class: 'empty-state' },
        h('h2', { text: 'Could not scan projects' }), h('p', { text: state.projectsError }),
        h('p', {}, h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: loadProjects }))));
      return;
    }
    if (!state.projects || !state.config) {
      list.append(h('div', { class: 'empty-state' }, h('h2', { text: 'Scanning folders' }),
        h('p', {}, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Looking for projects with skills.')));
      return;
    }
    const cfg = state.config;
    const pr = state.projects;
    if (!cfg.projectRoots.length) {
      list.append(h('div', { class: 'empty-state' },
        h('h2', { text: 'No project folders yet' }),
        h('p', { text: 'skm does not scan anything by default. Add a folder that holds your projects, for example ~/code, and skm will look inside it for projects that have skills in .agents/skills or .claude/skills.' }),
        rootForm(true)));
      return;
    }
    const q = state.q.trim().toLowerCase();
    const shown = pr.projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.skills.some((k) => k.name.toLowerCase().includes(q)));
    list.append(h('div', { class: 'pview' },
      rootsPanel(cfg),
      state.projectsLoading ? h('p', { class: 'meta', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Scanning.') : null,
      h('section', { 'aria-label': 'Projects found' },
        h('h2', { class: 'section-label', text: `Projects found (${pr.projects.length})` }),
        shown.length
          ? h('div', { class: 'pgrid' }, shown.map(projectCard))
          : h('div', { class: 'empty-state' }, h('h2', { text: pr.projects.length ? 'No matching projects' : 'No projects found' }),
            h('p', { text: pr.projects.length ? 'Try a different search.' : `Nothing with skills was found within ${cfg.scanDepth} ${cfg.scanDepth === 1 ? 'level' : 'levels'} of your folders. Add another folder or increase the depth.` }))),
      repeatedPanel(pr)));
  }

  function rootsPanel(cfg) {
    const sel = h('select', { id: 'depth', 'data-fk': 'depth', onchange: (e) => setDepth(Number(e.target.value)) },
      [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: n, text: `${n} ${n === 1 ? 'level' : 'levels'}`, selected: n === cfg.scanDepth ? true : null })));
    return h('section', { class: 'panel', 'aria-label': 'Scan folders' },
      h('div', { class: 'panel-head' },
        h('h2', { class: 'section-label', text: 'Scan folders' }),
        h('div', { class: 'depth' }, h('label', { for: 'depth', text: 'Scan depth' }), sel)),
      h('ul', { class: 'roots' }, cfg.projectRoots.map((r) => h('li', {},
        h('code', { text: r }),
        h('button', { class: 'btn small danger', type: 'button', 'aria-label': `Remove ${r}`, 'data-fk': `rm:${r}`, text: 'Remove', onclick: () => removeRoot(r) })))),
      rootForm(false));
  }

  function projectCard(p) {
    const active = p.skills.filter((k) => k.active);
    const tokens = active.reduce((n, k) => n + (k.cost ? k.cost.listing : 0), 0);
    const maxCost = Math.max(1, ...p.skills.map((k) => (k.cost ? k.cost.listing : 0)));
    return h('article', { class: 'card project', 'aria-labelledby': `pn-${p.root}` },
      h('div', { class: 'card-top' },
        h('div', { class: 'card-id' },
          h('h3', { class: 'name', id: `pn-${p.root}`, text: p.name }),
          h('span', { class: 'meta mono', title: p.root, text: shortPath(p.root) })),
        h('span', { class: 'meta', text: `${active.length}/${p.skills.length} active, ~${fmtTok(tokens)} tok` })),
      h('ul', { class: 'prows' }, p.skills.map((k) => projectSkillRow(p, k, maxCost))),
      h('div', { class: 'card-foot' },
        h('span', { class: 'meta', text: `${p.skills.length} ${p.skills.length === 1 ? 'skill' : 'skills'}` }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn small', type: 'button', text: 'Copy from global', onclick: () => copyFromGlobal(p) }))));
  }

  function projectSkillRow(p, k, maxCost) {
    const busy = state.busy.has(pkey(p.root, k.name));
    const inGlobal = skillsOf('global').some((g) => g.name === k.name);
    return h('li', { class: `prow${k.active ? '' : ' inactive'}${busy ? ' busy' : ''}` },
      h('div', { class: 'prow-main' },
        h('span', { class: 'pname', text: k.name }),
        h('div', { class: 'badges' },
          k.status !== 'ok' ? badge(k.status) : null,
          !k.active ? h('span', { class: 'badge plain', text: 'Inactive' }) : null,
          costBadge(k),
          inGlobal ? h('span', { class: 'badge also', text: 'Also global' }) : null),
        k.cost ? h('div', { class: `costbar${k.active ? '' : ' off'}`, 'aria-hidden': 'true', title: costTitle(k) }, h('i', { style: `width:${Math.max(2, Math.round((k.cost.listing / maxCost) * 100))}%` })) : null),
      h('div', { class: 'prow-actions' },
        h('button', { class: 'btn small', type: 'button', text: 'Promote to global', 'aria-label': `Promote ${k.name} from ${p.name} to global`, onclick: () => promote({ name: k.name, alsoIn: inGlobal ? ['global'] : [] }, p.root) }),
        h('button', {
          class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(k.active), 'data-fk': `psw:${pkey(p.root, k.name)}`,
          'aria-label': `${k.active ? 'Deactivate' : 'Activate'} ${k.name} in ${p.name}`,
          title: k.active ? 'Active. Click to deactivate.' : 'Inactive. Click to activate.',
          onclick: () => perform(null, { action: k.active ? 'deactivate' : 'activate', scope: 'local', name: k.name, projectRoot: p.root }, { busyKey: pkey(p.root, k.name) }),
        })));
  }

  async function copyFromGlobal(p) {
    const globals = skillsOf('global').filter((g) => g.status !== 'empty');
    if (!globals.length) { toast('There are no global skills to copy.', 'error'); return; }
    const here = new Set(p.skills.map((k) => k.name));
    const base = { action: 'copyToLocal', scope: 'global', projectRoot: p.root };
    const values = await confirmDialog({
      title: `Copy a global skill into ${p.name}`,
      lead: 'Copies the skill into this project. The global copy stays.',
      confirmLabel: 'Copy',
      options: [
        { type: 'select', name: 'name', label: 'Global skill', choices: globals.map((g) => ({ value: g.name, label: here.has(g.name) ? `${g.name} (already in this project)` : g.name })) },
        { type: 'radio', name: 'target', value: 'claude', label: 'Into .claude/skills', hint: 'Visible to Claude in this project.', checked: true },
        { type: 'radio', name: 'target', value: 'agents', label: 'Into .agents/skills', hint: 'Shared with other agents in this project.' },
        { type: 'checkbox', name: 'overwrite', label: 'Overwrite if it already exists here', hint: 'Needed when the project already has a skill with this name.', checked: false },
      ],
      preview: async (v) => previewOf(await safeDry({ ...base, name: v.name, target: v.target, overwrite: !!v.overwrite })),
    });
    if (values) await perform(null, { ...base, name: values.name, target: values.target, overwrite: !!values.overwrite }, { busyKey: pkey(p.root, values.name) });
  }

  function repeatedPanel(pr) {
    const rep = pr.repeated || [];
    return h('section', { class: 'panel', 'aria-label': 'Repeated skills' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'section-label', text: `Repeated skills (${rep.length})` })),
      rep.length
        ? h('ul', { class: 'reps' }, rep.map((r) => repeatedRow(r, pr)))
        : h('p', { class: 'meta', text: 'No skill name appears in more than one project.' }));
  }

  function repeatedRow(r, pr) {
    const nameOf = (root) => (pr.projects.find((p) => p.root === root) || { name: baseName(root) }).name;
    return h('li', { class: 'rep' },
      h('div', { class: 'rep-main' },
        h('span', { class: 'pname', text: r.name }),
        h('div', { class: 'badges' },
          r.identical ? h('span', { class: 'badge ok', text: 'Identical' }) : h('span', { class: 'badge bad', text: 'Diverged' }),
          r.inGlobal ? h('span', { class: 'badge also', text: 'In global' }) : h('span', { class: 'badge warn', text: 'Not in global' })),
        h('div', { class: 'paths' }, r.projects.map((root) => h('span', { class: 'path', title: root }, h('span', { text: nameOf(root) }))))),
      h('button', { class: 'btn small', type: 'button', text: 'Promote', 'aria-label': `Promote ${r.name} to global`, onclick: () => promoteRepeated(r, nameOf) }));
  }

  async function promoteRepeated(r, nameOf) {
    const base = { action: 'promote', scope: 'local', name: r.name };
    const options = [];
    if (r.projects.length > 1) {
      options.push({ type: 'select', name: 'root', label: 'Promote the copy from', hint: r.identical ? 'The copies are identical, so any project works.' : 'The copies differ. Pick the one you want in global.', choices: r.projects.map((root) => ({ value: root, label: nameOf(root) })) });
    }
    if (r.inGlobal) options.push({ type: 'checkbox', name: 'overwrite', label: 'Overwrite the global copy', hint: 'A global skill with this name already exists.', checked: false });
    const values = await confirmDialog({
      title: `Promote ${r.name} to global`,
      lead: 'Copies this skill to your global store and links it for Claude. The project copies stay.',
      confirmLabel: 'Promote',
      options,
      preview: async (v) => previewOf(await safeDry({ ...base, projectRoot: v.root || r.projects[0], overwrite: !!v.overwrite })),
    });
    if (!values) return;
    const root = values.root || r.projects[0];
    await perform(null, { ...base, projectRoot: root, overwrite: !!values.overwrite }, { busyKey: pkey(root, r.name) });
  }

  // ---------- wiring ----------

  function setScope(scope) {
    state.scope = scope;
    state.filter = 'all';
    render();
    if (scope === 'projects' && !state.projects && !state.projectsLoading) loadProjects();
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setScope(tab.dataset.scope));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = SCOPES.indexOf(tab.dataset.scope) + (e.key === 'ArrowRight' ? 1 : -1);
      const next = SCOPES[(i + SCOPES.length) % SCOPES.length];
      setScope(next);
      $(`#tab-${next}`).focus();
    });
  });

  $('#check-btn').addEventListener('click', checkUpdates);
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

  $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      $('#search').focus();
    }
  });

  // click on the drawer backdrop closes it
  $('#drawer').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  refresh();
})();
