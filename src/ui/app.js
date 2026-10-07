/* skm UI. Vanilla JS, no build step. Talks to the HTTP API in docs/ARCHITECTURE.md. */
(() => {
  'use strict';

  // ---------- theme (System / Light / Dark) ----------
  // The inline script in index.html applies the saved choice before paint; the
  // CSS follows the OS on its own while no data-theme is set.

  (() => {
    const root = document.documentElement;
    const group = document.getElementById('theme');
    if (!group) return;
    const buttons = Array.from(group.querySelectorAll('[data-theme-value]'));
    let mode = root.getAttribute('data-theme') || 'system';
    const sync = () => buttons.forEach((b) => {
      const on = b.dataset.themeValue === mode;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const set = (next) => {
      mode = next;
      if (next === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', next);
      try {
        if (next === 'system') localStorage.removeItem('skm-theme');
        else localStorage.setItem('skm-theme', next);
      } catch { /* storage blocked: the choice lasts for this page only */ }
      sync();
    };
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => set(b.dataset.themeValue));
      b.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const n = buttons[(i + step + buttons.length) % buttons.length];
        n.focus();
        set(n.dataset.themeValue);
      });
    });
    sync();
  })();

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
    hiddenOpen: false, // Projects tab: the Hidden (ignored) section is collapsed until asked for
    ignoreDraft: '',
    ignoreError: '',
    favOnly: false,
    tags: new Set(), // tag filter, AND semantics
    selecting: false, // multi-select mode (Global tab only)
    selected: new Set(), // skill names picked for the batch copy
    ptags: new Set(), // project tag filter (Projects tab), AND semantics
    onlyWithSkills: false, // Projects tab: hide projects that have no skills yet
    showArchived: false, // Projects tab: archived projects are hidden until asked for
    profiles: null, // GET /api/profiles payload, loaded when the Profiles tab (or an Apply profile dialog) first needs it
    profilesError: null,
  };

  const TAG_RE = /^[a-z0-9-]{1,24}$/;
  const MAX_TAGS = 8;
  const MAX_DESC = 300;
  const MAX_NOTES = 2000;
  const PROJECT_STATUS = {
    active: { label: 'Active' },
    paused: { label: 'Paused', tone: 'warn' },
    archived: { label: 'Archived', tone: 'plain' },
  };

  const SCOPES = ['global', 'local', 'projects', 'profiles'];
  const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
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
    const parts = p.replace(/^(?:\/(?:Users|home)\/[^/\\]+|[A-Za-z]:[\\/]+Users[\\/]+[^/\\]+)/, '~').split(/[\\/]+/);
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

  function fmtAgo(iso) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    const plural = (n, u) => `${n} ${u}${n === 1 ? '' : 's'} ago`;
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return plural(days, 'day');
    if (days < 365) return plural(Math.floor(days / 30), 'month');
    return plural(Math.floor(days / 365), 'year');
  }

  const fmtTok = (n) => Number(n || 0).toLocaleString('en-US');
  const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

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
        body: json,
      });
    }
    return json;
  }

  // ---------- toasts ----------

  function toast(message, kind = 'info', action) {
    const box = $('#toasts');
    const t = h('div', { class: `toast ${kind}` },
      h('span', { text: message }),
      action ? h('button', { type: 'button', text: action.label, onclick: () => { t.remove(); action.run(); } }) : null,
      h('button', { type: 'button', 'aria-label': 'Dismiss message', text: 'Close', onclick: () => t.remove() }));
    box.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 9000 : action ? 10000 : 5000);
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
    if (state.profiles) await loadProfiles();
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
    renderTagbar();
    renderSelectToggle();
    renderList();
    renderActionBar();
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
    if (!state.data || state.scope === 'projects' || state.scope === 'profiles') { el.hidden = true; return; }
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
    const fc = $('#count-profiles');
    fc.hidden = !state.profiles;
    fc.textContent = state.profiles ? state.profiles.profiles.length : 0;
    const proj = state.scope === 'projects';
    const prof = state.scope === 'profiles';
    $('#chips').hidden = prof;
    $('#sort-box').hidden = proj || prof;
    $('#sort').value = state.sort;
    $('.toolbar').classList.toggle('no-sort', proj || prof);
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.scope === state.scope;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    $('#list').setAttribute('aria-labelledby', `tab-${state.scope}`);
    $('#search').placeholder = proj ? 'Search projects' : prof ? 'Search profiles' : 'Search skills';
    $('label[for="search"]').textContent = proj
      ? 'Search projects by name, tag, description, stack, notes, README or remote'
      : prof ? 'Search profiles by name or skill' : 'Search skills by name, description or tag';
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

  const metaOf = (s) => s.meta || { favorite: false, tags: [] };
  const matchesMeta = (s) => (!state.favOnly || metaOf(s).favorite) && [...state.tags].every((t) => metaOf(s).tags.includes(t));

  function favCount() {
    const d = state.data;
    if (d && typeof d.favorites === 'number') return d.favorites;
    return new Set([...skillsOf('global'), ...skillsOf('local')].filter((s) => metaOf(s).favorite).map((s) => s.name)).size;
  }

  function tagList() {
    const d = state.data;
    if (d && Array.isArray(d.tags)) return d.tags;
    const counts = new Map();
    const seen = new Set();
    for (const s of [...skillsOf('global'), ...skillsOf('local')]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      for (const t of metaOf(s).tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  function renderChips() {
    const box = $('#chips');
    if (state.scope === 'projects') { renderProjectChips(box); return; }
    if (state.scope === 'profiles') { box.replaceChildren(); return; }
    box.setAttribute('aria-label', 'Filter by status');
    const defs = chipDefs(skillsOf(state.scope));
    const cur = defs.find((c) => c.id === state.filter);
    if (!cur || (state.filter === 'update' && !cur.n)) state.filter = 'all';
    const chips = defs.map((c) =>
      h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(c.id === state.filter), 'data-fk': `chip:${c.id}`,
        onclick: () => { state.filter = c.id; render(); },
      }, c.label, ' ', h('span', { class: 'n', text: c.n })));
    // Favorites is a toggle that combines with the status chips, not one of the exclusive choices.
    chips.splice(1, 0, h('button', {
      class: 'chip fav', type: 'button', 'aria-pressed': String(state.favOnly), 'data-fk': 'chip:fav',
      onclick: () => { state.favOnly = !state.favOnly; render(); },
    }, starIcon(state.favOnly), 'Favorites ', h('span', { class: 'n', text: favCount() })));
    box.replaceChildren(...chips);
  }

  function renderTagbar() {
    const box = $('#tagbar');
    const proj = state.scope === 'projects';
    const tags = proj ? projectTagList() : tagList();
    const sel = proj ? state.ptags : state.tags;
    const pre = proj ? 'pt' : 'tf';
    const noun = proj ? 'projects' : 'skills';
    if (proj ? state.projects : state.data) for (const t of [...sel]) if (!tags.some((x) => x.tag === t)) sel.delete(t);
    $('#tag-suggest').replaceChildren(...tagList().map((t) => h('option', { value: t.tag })));
    box.hidden = !state.data || !tags.length || state.scope === 'profiles';
    if (box.hidden) return;
    box.replaceChildren(...[
      h('span', { class: 'tagbar-label', id: 'tagbar-label', text: proj ? 'Project tags' : 'Tags' }),
      ...tags.map((t) => h('button', {
        class: 'chip tagchip', type: 'button', 'aria-pressed': String(sel.has(t.tag)), 'data-fk': `${pre}:${t.tag}`,
        onclick: () => { if (sel.has(t.tag)) sel.delete(t.tag); else sel.add(t.tag); render(); },
      }, t.tag, ' ', h('span', { class: 'n', text: t.count }))),
      sel.size
        ? h('button', { class: 'btn small ghost', type: 'button', 'data-fk': `${pre}-clear`, text: 'Clear tags', onclick: () => { sel.clear(); render(); } })
        : null,
      sel.size > 1 ? h('span', { class: 'meta', text: `Showing ${noun} that have all of these tags.` }) : null].filter(Boolean));
  }

  function renderSelectToggle() {
    const btn = $('#select-toggle');
    const can = !!state.data && state.scope === 'global' && !!state.data.project;
    btn.hidden = !can;
    if (!can && state.selecting) { state.selecting = false; state.selected.clear(); }
    btn.setAttribute('aria-pressed', String(state.selecting));
    btn.textContent = state.selecting ? 'Done selecting' : 'Select skills';
  }

  function visibleSkills() {
    const q = state.q.trim().toLowerCase();
    return skillsOf(state.scope)
      .filter(matchesFilter)
      .filter(matchesMeta)
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q) || metaOf(s).tags.some((t) => t.includes(q)))
      .sort((a, b) => (state.sort === 'cost' ? costOf(b) - costOf(a) : 0) || a.name.localeCompare(b.name));
  }

  function renderList() {
    const list = $('#list');
    list.replaceChildren();
    if (!state.data) {
      list.append(emptyState(state.loadError ? 'Could not load skills' : 'Loading', state.loadError || 'One moment.'));
      return;
    }
    if (state.scope === 'projects') { renderProjects(list); return; }
    if (state.scope === 'profiles') { renderProfiles(list); return; }
    if (state.scope === 'local' && !state.data.project) {
      list.append(emptyState('No project here',
        'Local skills live inside a project folder. Run skm from a folder that has .git, .agents or .claude to manage them.'));
      return;
    }
    const all = skillsOf(state.scope);
    const shown = visibleSkills();
    const maxCost = Math.max(1, ...all.map(costOf));
    if (!shown.length) {
      list.append(all.length
        ? emptyState('No matching skills', 'Try a different search, or clear the status, favorites and tag filters.')
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

  function starIcon(on) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `star${on ? ' on' : ''}`);
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'polygon');
    p.setAttribute('points', '12 2.5 14.94 8.46 21.5 9.41 16.75 14.04 17.88 20.57 12 17.48 6.12 20.57 7.25 14.04 2.5 9.41 9.06 8.46');
    svg.append(p);
    return svg;
  }

  function xIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('class', 'xicon');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M3 3l6 6M9 3l-6 6');
    svg.append(p);
    return svg;
  }

  function favButton(s) {
    const on = metaOf(s).favorite;
    return h('button', {
      class: 'star-btn', type: 'button', 'aria-pressed': String(on), 'data-fk': `fav:${key(s)}`,
      'aria-label': `Favorite ${s.name}`, title: on ? 'Favorite. Click to remove.' : 'Mark as favorite.',
      onclick: async () => { const e = await setMeta(s, { favorite: !on }); if (e) toast(e, 'error'); },
    }, starIcon(on));
  }

  /** Writes favorite/tags for a skill name, then reloads. Resolves with an error message or null. */
  async function setMeta(s, body) {
    try {
      await api('/api/meta', { name: s.name, ...body });
    } catch (e) {
      return e.message;
    }
    await refresh();
    return null;
  }

  function tagError(s, raw, tags) {
    const t = raw.trim().toLowerCase().replace(/^#/, '');
    if (!t) return { error: 'Type a tag first.' };
    if (!TAG_RE.test(t)) return { error: 'Tags use 1 to 24 characters: lowercase letters, digits and hyphens.' };
    if (tags.includes(t)) return { error: `Already tagged ${t}.` };
    if (tags.length >= MAX_TAGS) return { error: `A skill can have at most ${MAX_TAGS} tags.` };
    return { tag: t };
  }

  function tagsBlock(s) {
    const k = key(s);
    const tags = metaOf(s).tags;
    const err = h('p', { class: 'tag-err', id: `te-${k}`, role: 'alert', hidden: true });
    const input = h('input', {
      type: 'text', class: 'tag-input', id: `ti-${k}`, name: 'tag', list: 'tag-suggest', placeholder: 'Add tag', autocomplete: 'off', spellcheck: 'false',
      maxlength: '40', 'aria-label': `Add a tag to ${s.name}`, 'aria-describedby': err.id, 'data-fk': `tag:${k}`,
    });
    const showErr = (msg) => { err.textContent = msg || ''; err.hidden = !msg; input.toggleAttribute('aria-invalid', !!msg); };
    input.addEventListener('input', () => showErr(''));
    const form = h('form', {
      class: 'tag-add',
      onsubmit: async (e) => {
        e.preventDefault();
        const r = tagError(s, input.value, tags);
        if (r.error) { showErr(r.error); return; }
        const msg = await setMeta(s, { addTags: [r.tag] });
        if (msg) showErr(msg);
      },
    }, input);
    return h('div', { class: 'tagsblock' },
      h('div', { class: 'tags' },
        tags.map((t) => h('span', { class: `tag${state.tags.has(t) ? ' on' : ''}` },
          h('button', {
            class: 'tag-name', type: 'button', 'aria-pressed': String(state.tags.has(t)), title: `Filter by ${t}`, 'data-fk': `tn:${k}:${t}`,
            onclick: () => { if (state.tags.has(t)) state.tags.delete(t); else state.tags.add(t); render(); },
          }, t),
          h('button', {
            class: 'tag-x', type: 'button', 'aria-label': `Remove tag ${t} from ${s.name}`, title: `Remove ${t}`, 'data-fk': `tx:${k}:${t}`,
            onclick: async () => { const msg = await setMeta(s, { removeTags: [t] }); if (msg) toast(msg, 'error'); },
          }, xIcon())),
        ),
        form),
      err);
  }

  function setPicked(name, on) {
    if (on) state.selected.add(name); else state.selected.delete(name);
    renderActionBar();
  }

  function card(s, maxCost = 1) {
    const k = key(s);
    const other = s.scope === 'global' ? 'local' : 'global';
    const has = (scope) => (s.alsoIn || []).includes(scope);
    const canNormalize = s.scope === 'global' && FIXABLE.has(s.status);

    const pick = state.selecting && s.scope === 'global';
    const el = h('article', { class: `card${s.active ? '' : ' inactive'}${state.busy.has(k) ? ' busy' : ''}${pick && state.selected.has(s.name) ? ' selected' : ''}`, 'aria-labelledby': `n-${k}` },
      h('div', { class: 'card-top' },
        pick ? h('input', {
          class: 'pick', type: 'checkbox', 'aria-label': `Select ${s.name}`, 'data-fk': `pick:${k}`,
          checked: state.selected.has(s.name) ? true : null,
          onchange: (e) => { setPicked(s.name, e.target.checked); el.classList.toggle('selected', e.target.checked); },
        }) : null,
        h('div', { class: 'card-id' },
          h('h3', { class: 'name', id: `n-${k}`, text: s.name }),
          h('div', { class: 'badges' },
            badge(s.status),
            !s.active ? h('span', { class: 'badge plain', text: 'Inactive' }) : null,
            costBadge(s),
            lintBadges(s),
            s.vsGlobal === 'diverged' ? h('span', { class: 'badge warn', title: 'The local copy differs from the global skill of the same name.', text: 'Differs from global' })
              : has(other) ? h('span', { class: 'badge also', text: `Also ${other}` }) : null,
            resultOf(s) ? updateBadge(resultOf(s)) : null,
            isModified(s) ? h('span', { class: 'badge warn', title: 'The files differ from the version that was installed.', text: 'Modified locally' }) : null)),
        h('div', { class: 'card-ctl' },
          favButton(s),
          h('button', {
            class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(s.active),
            'aria-label': `${s.active ? 'Deactivate' : 'Activate'} ${s.name}`, 'data-fk': `sw:${k}`,
            title: s.active ? 'Active. Click to deactivate.' : 'Inactive. Click to activate.',
            onclick: () => toggle(s),
          }))),
      h('p', { class: `desc${s.description ? '' : ' empty'}`, text: s.description || 'No description in SKILL.md.' }),
      tagsBlock(s),
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
          s.scope === 'local' && s.vsGlobal === 'diverged' ? h('button', { class: 'btn small', type: 'button', text: 'Update local from global', 'data-fk': `rf:${k}`, onclick: () => refreshFromGlobal([s.name]) }) : null,
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
      lead: s.active
        ? 'Copies the skill into this project. The global copy stays.'
        : 'Copies the skill into this project, where the copy is active. The global copy stays inactive.',
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

  /**
   * Replace local copies with the global ones (`names`, several at once in a project card). One name shows the
   * global -> local diff, like update does. `project` = { root, name } for a project from the index.
   */
  async function refreshFromGlobal(names, project) {
    const projectRoot = project ? project.root : null;
    const base = { action: 'refresh', scope: 'local', ...(names.length === 1 ? { name: names[0] } : { names }), ...(projectRoot ? { projectRoot } : {}) };
    const inactive = names.filter((n) => { const g = skillsOf('global').find((x) => x.name === n); return g && !g.active; });
    const one = names.length === 1;
    const where = project ? ` in ${project.name}` : '';
    const values = await confirmDialog({
      title: one ? `Update local ${names[0]} from global` : `Update ${names.length} local skills from global${where}`,
      lead: `Replaces the local ${one ? 'copy' : 'copies'}${where} with the global ${one ? 'skill' : 'skills'}. The old local ${one ? 'folder goes' : 'folders go'} to the system Trash, so local edits are only kept there.`
        + (inactive.length ? ` ${one ? 'The global skill' : `Global ${inactive.join(', ')}`} ${inactive.length === 1 ? 'is' : 'are'} inactive and ${inactive.length === 1 ? 'stays' : 'stay'} that way.` : ''),
      confirmLabel: one ? 'Update local' : `Update ${names.length} skills`,
      danger: true,
      preview: async () => {
        if (one) return previewOf(await safeDry(base));
        try { return batchPreview(await batchCall({ ...base, dryRun: true }), 'will be updated'); } catch (e) { return { error: e.message }; }
      },
      extra: one ? async () => {
        const q = new URLSearchParams({ scope: 'local', name: names[0], ...(projectRoot ? { projectRoot } : {}) });
        return diffView(await api(`/api/diff?${q}`), false, 'This compares the local copy with the global one, so your local edits appear as removed lines and will be replaced.');
      } : null,
    });
    if (!values) return;
    const keys = names.map((n) => (projectRoot ? pkey(projectRoot, n) : `local:${n}`));
    for (const k of keys) state.busy.add(k);
    render();
    try {
      const res = await batchCall({ ...base });
      const failed = (res.results || []).filter((r) => !r.ok);
      toast(failed.length ? `${res.message}. Failed: ${failed.map((r) => `${r.name} (${r.error})`).join('; ')}` : res.message, failed.length ? 'error' : 'info');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      for (const k of keys) state.busy.delete(k);
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

  function diffView(d, modified, note) {
    const st = d.stats || {};
    const files = d.files || [];
    const parts = [['modified', st.modified], ['added', st.added], ['removed', st.removed]].filter(([, n]) => n);
    const wrap = h('div', { class: 'diff' },
      h('p', { class: 'diff-stats' },
        h('strong', { text: files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'} changed` : 'No differences' }),
        parts.length ? ` (${parts.map(([k, n]) => `${n} ${k}`).join(', ')})` : '',
        d.from && d.to ? h('span', { class: 'diff-rev', text: `${d.from} to ${d.to}` }) : null,
        h('span', { class: 'diff-counts' }, h('i', { class: 'add', text: `+${st.insertions || 0}` }), ' ', h('i', { class: 'del', text: `-${st.deletions || 0}` }))),
      h('p', { class: `diff-note${modified || note ? ' strong' : ''}`, text: note || (modified
        ? 'This compares your installed copy with the latest upstream, so your local edits appear as removed lines and will be replaced.'
        : 'This compares your installed copy with the latest upstream. Anything you changed locally would appear as removed lines.') }));
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
        : { roots: [], projects: [], repeated: [], ignored: [] };
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

  /** POST /api/project-ignore; resolves to the stored list, or null after showing the error (inline when `inline`). */
  async function changeIgnore(body, inline) {
    try {
      const res = await api('/api/project-ignore', body);
      state.ignoreError = '';
      return res.ignore;
    } catch (e) {
      if (inline) state.ignoreError = e.message; else toast(e.message, 'error');
      render();
      return null;
    }
  }

  async function ignoreProject(p) {
    if (!(await changeIgnore({ add: [p.root] }))) return;
    toast(`Hid ${p.name}.`, 'info', { label: 'Undo', run: () => unignoreEntry(p.root, `Brought ${p.name} back.`) });
    await loadProjects();
  }

  async function unignoreEntry(entry, okMessage) {
    if (!(await changeIgnore({ remove: [entry] }))) return;
    if (okMessage) toast(okMessage);
    await loadProjects();
  }

  async function addIgnore() {
    const v = state.ignoreDraft.trim();
    if (!v) { state.ignoreError = 'Type a folder path or a name pattern first.'; render(); return; }
    if (await changeIgnore({ add: [v] }, true)) {
      state.ignoreDraft = '';
      await loadProjects();
    }
  }

  function hiddenPanel(pr) {
    const list = pr.ignored || [];
    const input = h('input', {
      type: 'text', id: 'ignore-input', name: 'ignore', placeholder: '~/old-stuff or *-backup', autocomplete: 'off', spellcheck: 'false',
      value: state.ignoreDraft, 'data-fk': 'ignore-input', 'aria-describedby': 'ignore-help ignore-error',
      'aria-invalid': state.ignoreError ? 'true' : null,
      oninput: (e) => { state.ignoreDraft = e.target.value; },
    });
    return h('section', { class: 'panel', 'aria-label': 'Hidden projects' },
      h('div', { class: 'panel-head' },
        h('h2', { class: 'section-label' },
          h('button', { class: 'disclosure', type: 'button', 'aria-expanded': String(state.hiddenOpen), 'aria-controls': 'hidden-body', 'data-fk': 'hidden-toggle',
            text: `${state.hiddenOpen ? '▾' : '▸'} Hidden (${list.length})`,
            onclick: () => { state.hiddenOpen = !state.hiddenOpen; render(); } }))),
      state.hiddenOpen ? h('div', { id: 'hidden-body', class: 'hidden-body' },
        h('p', { class: 'meta', id: 'ignore-help', text: 'A hidden folder is not listed or searched, and neither is anything inside it. A path hides that folder and everything below it; a name pattern (only * is a wildcard) hides every folder with a matching name.' }),
        list.length
          ? h('ul', { class: 'roots' }, list.map((i) => h('li', {},
            h('span', { class: 'ignore-entry' },
              h('code', { text: i.entry }),
              h('span', { class: 'stackchip', text: i.kind === 'glob' ? 'name pattern' : 'path' }),
              h('span', { class: 'meta', text: i.matches === 1 ? 'hides 1 folder' : `hides ${i.matches} folders` })),
            h('button', { class: 'btn small', type: 'button', 'aria-label': `Unhide ${i.entry}`, 'data-fk': `unhide:${i.entry}`, text: 'Remove', onclick: () => unignoreEntry(i.entry, `Unhid ${i.entry}.`) }))))
          : h('p', { class: 'meta', text: 'Nothing is hidden.' }),
        h('form', { class: 'rootform', onsubmit: (e) => { e.preventDefault(); addIgnore(); } },
          h('label', { class: 'sr', for: 'ignore-input', text: 'Folder path or name pattern to hide' }),
          input,
          h('button', { class: 'btn', type: 'submit', 'data-fk': 'ignore-add', text: 'Hide' })),
        h('p', { class: 'form-error', id: 'ignore-error', role: 'alert', text: state.ignoreError })) : null);
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
    const shown = visibleProjects();
    const hidden = pr.projects.length - eligibleProjects().length;
    list.append(h('div', { class: 'pview' },
      rootsPanel(cfg),
      state.projectsLoading ? h('p', { class: 'meta', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Scanning.') : null,
      h('section', { 'aria-label': 'Projects found' },
        h('h2', { class: 'section-label', text: `Projects found (${shown.length === pr.projects.length ? shown.length : `${shown.length} of ${pr.projects.length}`})` }),
        shown.length
          ? h('div', { class: 'pgrid' }, shown.map(projectCard))
          : h('div', { class: 'empty-state' }, h('h2', { text: pr.projects.length ? 'No matching projects' : 'No projects found' }),
            h('p', { text: pr.projects.length ? `Try a different search, or clear the tag filters${hidden ? ' and show archived projects' : ''}.` : `No projects were found within ${cfg.scanDepth} ${cfg.scanDepth === 1 ? 'level' : 'levels'} of your folders. Add another folder or increase the depth.` }))),
      repeatedPanel(pr),
      hiddenPanel(pr)));
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

  // ---------- project index (meta, auto facts, search, edit) ----------

  const pmetaOf = (p) => p.meta || { description: '', tags: [], status: '', notes: '' };
  const pautoOf = (p) => p.auto || {};
  const pstatusOf = (p) => pmetaOf(p).status || 'active';
  const isArchived = (p) => pstatusOf(p) === 'archived';

  /** Same matching as the contract: every whitespace-separated token must hit some field, case-insensitive. */
  function projectMatches(p, q) {
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const m = pmetaOf(p);
    const a = pautoOf(p);
    const hay = [p.name, ...m.tags, m.description, ...(a.stack || []), m.notes, a.readme, a.remote, p.root, ...p.skills.map((k) => k.name)]
      .filter(Boolean).join('\n').toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }

  /** Projects that pass the status filter (archived hidden by default). */
  const statusEligible = () => (state.projects ? state.projects.projects.filter((p) => state.showArchived || !isArchived(p)) : []);
  const eligibleProjects = () => statusEligible().filter((p) => !state.onlyWithSkills || p.skills.length);

  function visibleProjects() {
    return eligibleProjects()
      .filter((p) => [...state.ptags].every((t) => pmetaOf(p).tags.includes(t)))
      .filter((p) => projectMatches(p, state.q));
  }

  function projectTagList() {
    const counts = new Map();
    for (const p of eligibleProjects()) for (const t of pmetaOf(p).tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  function renderProjectChips(box) {
    box.setAttribute('aria-label', 'Filter projects by status');
    const n = state.projects ? state.projects.projects.filter(isArchived).length : 0;
    const empty = statusEligible().filter((p) => !p.skills.length).length;
    box.replaceChildren(
      ...(n || state.showArchived ? [h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(state.showArchived), 'data-fk': 'chip:archived',
        onclick: () => { state.showArchived = !state.showArchived; render(); },
      }, 'Show archived ', h('span', { class: 'n', text: n }))] : []),
      ...(empty || state.onlyWithSkills ? [h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(state.onlyWithSkills), 'data-fk': 'chip:with-skills',
        title: 'Hide projects that have no skills yet',
        onclick: () => { state.onlyWithSkills = !state.onlyWithSkills; render(); },
      }, 'Only with skills ', h('span', { class: 'n', text: statusEligible().length - empty }))] : []));
  }

  function projectDescription(p) {
    const m = pmetaOf(p);
    const readme = pautoOf(p).readme;
    if (m.description) return h('p', { class: 'desc pdesc', text: m.description });
    if (readme) return h('p', { class: 'desc pdesc auto' }, readme, h('span', { class: 'from-readme', text: 'from README' }));
    return null;
  }

  function projectFacts(p) {
    const a = pautoOf(p);
    const items = [
      a.remote ? h('span', { class: 'pfact mono', title: 'Git remote', text: a.remote }) : null,
      a.branch ? h('span', { class: 'pfact', title: 'Current branch' }, 'Branch ', h('b', { text: a.branch })) : null,
      a.lastCommitAt && fmtAgo(a.lastCommitAt)
        ? h('span', { class: 'pfact' }, 'Last commit ', h('time', { datetime: a.lastCommitAt, title: new Date(a.lastCommitAt).toLocaleString(), text: fmtAgo(a.lastCommitAt) }))
        : null].filter(Boolean);
    return items.length ? h('div', { class: 'pfacts' }, items) : null;
  }

  function projectCard(p) {
    const active = p.skills.filter((k) => k.active);
    const tokens = active.reduce((n, k) => n + (k.cost ? k.cost.listing : 0), 0);
    const maxCost = Math.max(1, ...p.skills.map((k) => (k.cost ? k.cost.listing : 0)));
    const m = pmetaOf(p);
    const st = pstatusOf(p);
    const stack = pautoOf(p).stack || [];
    const diverged = p.skills.filter((k) => k.vsGlobal === 'diverged').map((k) => k.name);
    const chips = [
      st !== 'active' ? h('span', { class: `badge ${PROJECT_STATUS[st].tone || 'plain'}`, text: PROJECT_STATUS[st].label }) : null,
      ...m.tags.map((t) => h('button', {
        class: 'ptag', type: 'button', 'aria-pressed': String(state.ptags.has(t)), title: `Filter projects by ${t}`, 'data-fk': `ptn:${p.root}:${t}`,
        onclick: () => { if (state.ptags.has(t)) state.ptags.delete(t); else state.ptags.add(t); render(); },
      }, t)),
      ...stack.map((t) => h('span', { class: 'stackchip', title: 'Detected stack', text: t }))].filter(Boolean);
    return h('article', { class: `card project${st === 'archived' ? ' archived' : ''}`, 'aria-labelledby': `pn-${p.root}` },
      h('div', { class: 'card-top' },
        h('div', { class: 'card-id' },
          h('h3', { class: 'name', id: `pn-${p.root}`, text: p.name }),
          h('span', { class: 'meta mono', title: p.root, text: shortPath(p.root) })),
        p.skills.length ? h('span', { class: 'meta', text: `${active.length}/${p.skills.length} active, ~${fmtTok(tokens)} tok` }) : null),
      projectDescription(p),
      chips.length ? h('div', { class: 'pchips' }, chips) : null,
      projectFacts(p),
      p.skills.length
        ? h('ul', { class: 'prows' }, p.skills.map((k) => projectSkillRow(p, k, maxCost)))
        : h('p', { class: 'meta noskills', text: 'No skills here yet' }),
      h('div', { class: 'card-foot' },
        h('span', { class: 'meta', text: `${p.skills.length} ${p.skills.length === 1 ? 'skill' : 'skills'}` }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn small', type: 'button', 'data-fk': `pe:${p.root}`, 'aria-label': `Edit ${p.name}`, text: 'Edit', onclick: () => openProjectEditor(p) }),
          h('button', { class: 'btn small', type: 'button', text: 'Copy from global', onclick: () => copyFromGlobal(p) }),
          diverged.length > 1 ? h('button', { class: 'btn small', type: 'button', 'data-fk': `prfa:${p.root}`, text: `Update ${diverged.length} from global`, title: `Diverged from global: ${diverged.join(', ')}`, onclick: () => refreshFromGlobal(diverged, p) }) : null,
          h('button', { class: 'btn small', type: 'button', 'data-fk': `pa:${p.root}`, 'aria-label': `Apply a profile to ${p.name}`, text: 'Apply profile', onclick: () => applyProfile({ root: p.root, name: p.name, skills: p.skills }) }),
          active.length ? h('button', { class: 'btn small', type: 'button', 'aria-label': `Save the active skills of ${p.name} as a profile`, text: 'Save as profile', onclick: () => openProfileEditor(null, { name: p.name, skills: active.map((k) => k.name) }) }) : null,
          h('button', { class: 'btn small', type: 'button', 'data-fk': `pi:${p.root}`, 'aria-label': `Ignore ${p.name}`, title: 'Hide this project from the index', text: 'Ignore', onclick: () => ignoreProject(p) }))));
  }

  /** The edit drawer: description, tags, status and notes of one project. Saves with POST /api/project-meta. */
  function openProjectEditor(p) {
    const dlg = $('#drawer');
    const m = pmetaOf(p);
    const draft = { tags: [...m.tags] };
    const id = (n) => `pe-${n}`;

    const counter = (el, max, node) => {
      const sync = () => {
        const n = el.value.length;
        node.textContent = `${n} / ${max}`;
        node.classList.toggle('over', n > max);
        el.toggleAttribute('aria-invalid', n > max);
      };
      el.addEventListener('input', sync);
      sync();
    };
    const desc = h('textarea', { id: id('desc'), name: 'description', rows: '3', 'aria-describedby': `${id('desc')}-n`, placeholder: 'What is this project, in a sentence or two?' });
    desc.value = m.description;
    const descN = h('span', { class: 'count-note', id: `${id('desc')}-n` });
    counter(desc, MAX_DESC, descN);
    const notes = h('textarea', { id: id('notes'), name: 'notes', rows: '5', 'aria-describedby': `${id('notes')}-n`, placeholder: 'Anything an agent or you should know before working here.' });
    notes.value = m.notes;
    const notesN = h('span', { class: 'count-note', id: `${id('notes')}-n` });
    counter(notes, MAX_NOTES, notesN);

    const status = h('select', { id: id('status'), name: 'status' },
      Object.entries(PROJECT_STATUS).map(([v, o]) => h('option', { value: v, text: o.label })));
    status.value = pstatusOf(p);

    // tags editor: same rules as the skill tags, edited locally and sent with Save
    const tagList_ = h('div', { class: 'tags' });
    const tagErr = h('p', { class: 'tag-err', id: id('tag-err'), role: 'alert', hidden: true });
    const inUse = [...new Set(state.projects.projects.flatMap((x) => pmetaOf(x).tags))].sort();
    const suggest = h('datalist', { id: id('suggest') }, inUse.map((t) => h('option', { value: t })));
    const tagInput = h('input', {
      type: 'text', class: 'tag-input', id: id('tag'), name: 'tag', list: suggest.id, placeholder: 'Add tag', autocomplete: 'off', spellcheck: 'false',
      maxlength: '40', 'aria-label': `Add a tag to ${p.name}`, 'aria-describedby': tagErr.id,
    });
    const showTagErr = (msg) => { tagErr.textContent = msg || ''; tagErr.hidden = !msg; tagInput.toggleAttribute('aria-invalid', !!msg); };
    const drawTags = () => tagList_.replaceChildren(
      ...draft.tags.map((t) => h('span', { class: 'tag' },
        h('span', { class: 'tag-name static', text: t }),
        h('button', {
          class: 'tag-x', type: 'button', 'aria-label': `Remove tag ${t}`, title: `Remove ${t}`,
          onclick: () => { draft.tags = draft.tags.filter((x) => x !== t); showTagErr(''); drawTags(); tagInput.focus(); },
        }, xIcon()))),
      h('span', { class: 'tag-add' }, tagInput));
    const addTag = () => {
      const r = tagError(null, tagInput.value, draft.tags);
      if (r.error) { showTagErr(r.error); return; }
      draft.tags = [...draft.tags, r.tag].sort();
      tagInput.value = '';
      showTagErr('');
      drawTags();
      $(`#${id('tag')}`).focus();
    };
    tagInput.addEventListener('input', () => showTagErr(''));
    tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
    drawTags();

    const formErr = h('p', { class: 'form-err', role: 'alert', hidden: true });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Save' });
    const closeBtn = h('button', { class: 'btn small ghost', type: 'button', text: 'Close', onclick: () => dlg.close() });
    const cancelBtn = h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => dlg.close() });
    const field = (label, forId, control, extra, hint) => h('div', { class: 'field' },
      h('div', { class: 'field-head' }, h('label', { for: forId, text: label }), extra || null),
      hint ? h('p', { class: 'field-hint', text: hint }) : null,
      control);

    const form = h('form', {
      class: 'drawer-body pedit', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        formErr.hidden = true;
        if (desc.value.length > MAX_DESC) { formErr.textContent = `The description is over ${MAX_DESC} characters.`; formErr.hidden = false; desc.focus(); return; }
        if (notes.value.length > MAX_NOTES) { formErr.textContent = `The notes are over ${MAX_NOTES} characters.`; formErr.hidden = false; notes.focus(); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving';
        try {
          await api('/api/project-meta', { root: p.root, description: desc.value.trim(), notes: notes.value.trim(), status: status.value, tags: draft.tags });
        } catch (er) {
          formErr.textContent = er.message;
          formErr.hidden = false;
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
          formErr.scrollIntoView({ block: 'nearest' });
          return;
        }
        dlg.close();
        toast(`Saved ${p.name}.`);
        await loadProjects();
      },
    },
      field('Description', id('desc'), desc, descN, 'Shown on the card and used by agents to find this project. Without one, the README line is used.'),
      h('div', { class: 'field' },
        h('div', { class: 'field-head' }, h('span', { class: 'field-label', id: id('tags-l'), text: 'Tags' })),
        h('p', { class: 'field-hint', text: `Up to ${MAX_TAGS}. Lowercase letters, digits and hyphens. Press Enter to add.` }),
        h('div', { class: 'tagsblock', role: 'group', 'aria-labelledby': id('tags-l') }, tagList_, tagErr, suggest)),
      field('Status', id('status'), status, null, 'Paused and archived projects are marked on the card. Archived ones are hidden unless you show them.'),
      field('Notes', id('notes'), notes, notesN),
      formErr,
      h('div', { class: 'modal-actions' }, cancelBtn, saveBtn));

    dlg.replaceChildren(h('div', { class: 'drawer-inner' },
      h('div', { class: 'drawer-head' },
        h('div', {}, h('div', { class: 'badges' }, h('span', { class: 'badge plain', text: 'Project' })),
          h('h2', { id: 'drawer-title', text: `Edit ${p.name}` }),
          h('p', { class: 'meta mono', text: p.root })),
        closeBtn),
      form));
    if (!dlg.open) dlg.showModal();
    desc.focus();
  }

  function projectSkillRow(p, k, maxCost) {
    const busy = state.busy.has(pkey(p.root, k.name));
    const inGlobal = skillsOf('global').some((g) => g.name === k.name);
    return h('li', { class: `prow${k.active ? '' : ' inactive'}${busy ? ' busy' : ''}` },
      h('div', { class: 'prow-main' },
        h('span', { class: 'pname' },
          k.name,
          metaOf(k).favorite ? h('span', { class: 'fav-mark', role: 'img', 'aria-label': 'Favorite', title: 'Favorite' }, starIcon(true)) : null),
        h('div', { class: 'badges' },
          k.status !== 'ok' ? badge(k.status) : null,
          !k.active ? h('span', { class: 'badge plain', text: 'Inactive' }) : null,
          costBadge(k),
          k.vsGlobal === 'diverged' ? h('span', { class: 'badge warn', title: 'Differs from the global skill of the same name.', text: 'Diverged from global' })
            : inGlobal ? h('span', { class: 'badge also', text: 'Also global' }) : null),
        k.cost ? h('div', { class: `costbar${k.active ? '' : ' off'}`, 'aria-hidden': 'true', title: costTitle(k) }, h('i', { style: `width:${Math.max(2, Math.round((k.cost.listing / maxCost) * 100))}%` })) : null),
      h('div', { class: 'prow-actions' },
        k.vsGlobal === 'diverged' ? h('button', { class: 'btn small', type: 'button', text: 'Update from global', 'data-fk': `prf:${pkey(p.root, k.name)}`, 'aria-label': `Update ${k.name} in ${p.name} from global`, onclick: () => refreshFromGlobal([k.name], p) }) : null,
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

  // ---------- profiles (skill kits) ----------

  async function loadProfiles() {
    try {
      state.profiles = await api('/api/profiles');
      state.profilesError = null;
    } catch (e) {
      state.profilesError = e.message;
    }
    render();
  }

  /** POST /api/profiles; resolves to the response, or null after showing the error (into `errEl` when given). */
  async function profileOp(body, errEl) {
    try {
      const res = await api('/api/profiles', body);
      state.profiles = { ...(state.profiles || {}), profiles: res.profiles };
      return res;
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; errEl.hidden = false; } else toast(e.message, 'error');
      return null;
    }
  }

  const globalSkill = (name) => skillsOf('global').find((g) => g.name === name);
  const localSkill = (name) => skillsOf('local').find((l) => l.name === name);
  const profileSlug = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

  function memberChip(name) {
    const g = globalSkill(name);
    const here = state.data.project && localSkill(name);
    const notes = [!g ? 'Not in global: reported as missing when the profile is applied.' : g.active ? 'Active in global.' : 'Inactive in global: copied into the project, stays inactive in global.'];
    if (here) notes.push(`Already in ${state.data.project.name}.`);
    return h('li', { class: `mchip${!g ? ' missing' : g.active ? '' : ' inactive'}`, title: notes.join(' ') },
      name,
      !g ? h('span', { class: 'sr', text: ' (missing from global)' }) : !g.active ? h('span', { class: 'sr', text: ' (inactive in global)' }) : null,
      here ? h('span', { class: 'mhere', 'aria-label': `already in ${state.data.project.name}`, text: '✓' }) : null);
  }

  function profileCard(p) {
    const proj = state.data.project;
    const missing = p.skills.filter((n) => !globalSkill(n)).length;
    const inactive = p.skills.filter((n) => { const g = globalSkill(n); return g && !g.active; }).length;
    const here = proj ? p.skills.filter(localSkill).length : 0;
    return h('article', { class: 'card profile', 'aria-labelledby': `fn-${p.name}` },
      h('div', { class: 'card-top' },
        h('div', { class: 'card-id' },
          h('h3', { class: 'name', id: `fn-${p.name}`, text: p.name }),
          h('div', { class: 'badges' },
            h('span', { class: 'badge plain', text: `${p.skills.length} ${p.skills.length === 1 ? 'skill' : 'skills'}` }),
            missing ? h('span', { class: 'badge warn', title: 'These names have no global skill. Applying the profile reports them and copies the rest.', text: `${missing} missing from global` }) : null,
            inactive ? h('span', { class: 'badge also', title: 'Inactive global skills are copied into the project and stay inactive in global.', text: `${inactive} inactive in global` }) : null,
            here ? h('span', { class: 'badge also', text: here === p.skills.length ? `All in ${proj.name}` : `${here} already in ${proj.name}` }) : null))),
      h('ul', { class: 'pmembers', 'aria-label': `Skills in ${p.name}` }, p.skills.map(memberChip)),
      h('div', { class: 'card-foot' },
        h('span', { class: 'meta', text: 'Copy every skill into a project in one step.' }),
        h('div', { class: 'actions' },
          proj ? h('button', { class: 'btn small primary', type: 'button', 'data-fk': `fa:${p.name}`, text: `Apply to ${proj.name}`, onclick: () => applyProfile({ name: proj.name }, p.name) }) : null,
          h('button', { class: 'btn small', type: 'button', 'data-fk': `fe:${p.name}`, 'aria-label': `Edit ${p.name}`, text: 'Edit', onclick: () => openProfileEditor(p) }),
          h('button', { class: 'btn small danger', type: 'button', 'aria-label': `Delete ${p.name}`, text: 'Delete', onclick: () => removeProfile(p) }))));
  }

  function renderProfiles(list) {
    if (state.profilesError && !state.profiles) {
      list.append(h('div', { class: 'empty-state' },
        h('h2', { text: 'Could not load profiles' }), h('p', { text: state.profilesError }),
        h('p', {}, h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: loadProfiles }))));
      return;
    }
    if (!state.profiles) {
      list.append(emptyState('Loading', 'Reading your profiles.'));
      return;
    }
    const all = state.profiles.profiles;
    const q = state.q.trim().toLowerCase();
    const shown = all.filter((p) => !q || p.name.includes(q) || p.skills.some((n) => n.toLowerCase().includes(q)));
    const proj = state.data.project;
    const activeHere = skillsOf('local').filter((s) => s.active).map((s) => s.name);
    const saveHere = proj && activeHere.length
      ? h('button', { class: 'btn small', type: 'button', 'data-fk': 'profile-save-here', text: `Save ${proj.name} as a profile`, onclick: () => openProfileEditor(null, { name: proj.name, skills: activeHere }) })
      : null;
    list.append(h('div', { class: 'pview' },
      h('section', { class: 'panel profiles-head', 'aria-label': 'About profiles' },
        h('div', { class: 'panel-head' },
          h('h2', { class: 'section-label', text: `Profiles (${shown.length === all.length ? all.length : `${shown.length} of ${all.length}`})` }),
          h('div', { class: 'actions' }, saveHere,
            h('button', { class: 'btn small primary', type: 'button', 'data-fk': 'profile-new', text: 'New profile', onclick: () => openProfileEditor(null) }))),
        h('p', { class: 'meta', text: 'A profile is a named list of skills. Applying it copies every skill into a project: skills already there are skipped unless you choose to overwrite, and names missing from global are reported. Inactive global skills are copied and stay inactive in global.' }),
        state.profiles.file ? h('p', { class: 'meta mono', title: state.profiles.file, text: `Stored in ${shortPath(state.profiles.file)}` }) : null),
      !all.length
        ? emptyState('No profiles yet', 'Create one from a list of skills, or save the active skills of a project as a profile.')
        : shown.length
          ? h('div', { class: 'pgrid' }, shown.map(profileCard))
          : emptyState('No matching profiles', 'Try a different search.')));
  }

  /** Create (p null, optional `prefill` { name, skills }) or edit a profile: name and members. */
  function openProfileEditor(p, prefill = {}) {
    if (!state.profiles) loadProfiles();
    const dlg = $('#drawer');
    const creating = !p;
    const draft = { skills: [...(p ? p.skills : prefill.skills || [])].sort() };
    const id = (n) => `pf-${n}`;
    const nameInput = h('input', {
      type: 'text', class: 'text-input', id: id('name'), name: 'name', maxlength: '48', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'capacitor-react-shadcn', 'aria-describedby': `${id('name')}-hint`,
    });
    nameInput.value = p ? p.name : profileSlug(prefill.name || '');

    const names = [...new Set([...skillsOf('global'), ...skillsOf('local')].map((s) => s.name))].sort();
    const suggest = h('datalist', { id: id('suggest') }, names.map((n) => h('option', { value: n })));
    const chips = h('div', { class: 'tags' });
    const skErr = h('p', { class: 'tag-err', id: id('sk-err'), role: 'alert', hidden: true });
    const skInput = h('input', {
      type: 'text', class: 'tag-input', id: id('skill'), name: 'skill', list: suggest.id, placeholder: 'Add skill', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Add a skill to the profile', 'aria-describedby': skErr.id,
    });
    const showSkErr = (msg) => { skErr.textContent = msg || ''; skErr.hidden = !msg; skInput.toggleAttribute('aria-invalid', !!msg); };
    const draw = () => chips.replaceChildren(
      ...draft.skills.map((n) => h('span', { class: `tag${globalSkill(n) ? '' : ' missing'}`, title: globalSkill(n) ? null : 'Not in global: reported as missing when the profile is applied.' },
        h('span', { class: 'tag-name static', text: n }),
        h('button', {
          class: 'tag-x', type: 'button', 'aria-label': `Remove ${n}`, title: `Remove ${n}`,
          onclick: () => { draft.skills = draft.skills.filter((x) => x !== n); showSkErr(''); draw(); skInput.focus(); },
        }, xIcon()))),
      h('span', { class: 'tag-add' }, skInput));
    const addSkill = () => {
      const v = skInput.value.trim();
      if (!v) { showSkErr('Type a skill name first.'); return; }
      if (v.startsWith('.') || /[\\/]/.test(v)) { showSkErr('That is not a skill name.'); return; }
      if (draft.skills.includes(v)) { showSkErr(`${v} is already in the profile.`); return; }
      draft.skills = [...draft.skills, v].sort();
      skInput.value = '';
      showSkErr('');
      draw();
      $(`#${id('skill')}`).focus();
    };
    skInput.addEventListener('input', () => showSkErr(''));
    skInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSkill(); } });
    draw();

    const formErr = h('p', { class: 'form-err', role: 'alert', hidden: true });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit', text: creating ? 'Create' : 'Save' });
    const closeBtn = h('button', { class: 'btn small ghost', type: 'button', text: 'Close', onclick: () => dlg.close() });
    const fail = (msg, focus) => { formErr.textContent = msg; formErr.hidden = false; if (focus) focus.focus(); };
    const form = h('form', {
      class: 'drawer-body pedit', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        formErr.hidden = true;
        const name = nameInput.value.trim().toLowerCase();
        if (!PROFILE_RE.test(name)) { fail('Use 1 to 48 characters for the name: lowercase letters, digits and hyphens, not starting with a hyphen.', nameInput); return; }
        if (skInput.value.trim()) addSkill();
        if (!draft.skills.length) { fail('Add at least one skill.', skInput); return; }
        saveBtn.disabled = true;
        const body = creating
          ? { op: 'create', name, skills: draft.skills }
          : { op: 'update', name: p.name, skills: draft.skills, ...(name !== p.name ? { rename: name } : {}) };
        if (!(await profileOp(body, formErr))) { saveBtn.disabled = false; return; }
        dlg.close();
        toast(creating ? `Created profile ${name}.` : `Saved profile ${name}.`);
        render();
      },
    },
      h('div', { class: 'field' },
        h('div', { class: 'field-head' }, h('label', { for: id('name'), text: 'Name' })),
        h('p', { class: 'field-hint', id: `${id('name')}-hint`, text: 'Lowercase letters, digits and hyphens, up to 48 characters.' }),
        nameInput),
      h('div', { class: 'field' },
        h('div', { class: 'field-head' }, h('span', { class: 'field-label', id: id('skills-l'), text: 'Skills' })),
        h('p', { class: 'field-hint', text: 'Type a skill name and press Enter. Any global skill works, active or inactive. A name that is not in global is kept and reported as missing when the profile is applied.' }),
        h('div', { class: 'tagsblock', role: 'group', 'aria-labelledby': id('skills-l') }, chips, skErr, suggest)),
      formErr,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => dlg.close() }), saveBtn));

    dlg.replaceChildren(h('div', { class: 'drawer-inner' },
      h('div', { class: 'drawer-head' },
        h('div', {}, h('div', { class: 'badges' }, h('span', { class: 'badge plain', text: 'Profile' })),
          h('h2', { id: 'drawer-title', text: creating ? 'New profile' : `Edit ${p.name}` })),
        closeBtn),
      form));
    if (!dlg.open) dlg.showModal();
    (nameInput.value ? skInput : nameInput).focus();
  }

  async function removeProfile(p) {
    const ok = await confirmDialog({
      title: `Delete profile ${p.name}`,
      lead: 'Removes the profile only. No skill folder is touched, in global or in any project.',
      confirmLabel: 'Delete profile',
      danger: true,
      preview: async () => ({ lines: [{ text: `remove profile ${p.name} (${p.skills.length} ${p.skills.length === 1 ? 'skill' : 'skills'}) from ${state.profiles && state.profiles.file ? shortPath(state.profiles.file) : 'profiles.json'}` }] }),
    });
    if (!ok || !(await profileOp({ op: 'delete', name: p.name }))) return;
    toast(`Deleted profile ${p.name}.`, 'info', {
      label: 'Undo',
      run: async () => { if (await profileOp({ op: 'create', name: p.name, skills: p.skills })) { toast(`Restored profile ${p.name}.`); render(); } },
    });
    render();
  }

  const APPLY_STATUS = { copied: { label: 'Copied', tone: 'accent', cls: 'ok' }, skipped: { label: 'Skipped', tone: 'plain', cls: 'muted' }, missing: { label: 'Missing', tone: 'warn', cls: 'muted' }, failed: { label: 'Failed', tone: 'bad', cls: 'bad' } };
  const applyNote = (r) => (r.status === 'copied' ? `Into .${r.target}/skills.` : r.status === 'skipped' ? `${r.reason[0].toUpperCase()}${r.reason.slice(1)}.` : r.status === 'missing' ? 'No global skill with this name.' : `${r.error || 'Unknown error.'}${r.code ? ` (${r.code})` : ''}`);

  function applyPreview(res) {
    const results = res.results || [];
    const lines = results.map((r) => ({ text: `${r.name}: ${r.status === 'copied' ? `will be copied into .${r.target}/skills` : r.status === 'skipped' ? `skipped, ${r.reason}` : r.status === 'missing' ? 'missing from global, not copied' : r.error || 'will fail'}`, error: r.status === 'failed' }));
    if ((res.changes || []).length) {
      lines.push({ text: 'Changes', group: true });
      res.changes.forEach((c) => lines.push({ text: c }));
    }
    return { lines, blocked: !results.some((r) => r.status === 'copied') };
  }

  /** Apply a profile to a project (`proj`: { name, root? }; no root = the current project). `fixed` skips the profile picker. */
  async function applyProfile(proj, fixed) {
    if (!state.profiles) await loadProfiles();
    const all = state.profiles ? state.profiles.profiles : [];
    if (!all.length) { toast('There are no profiles yet. Create one in the Profiles tab.', 'error'); return; }
    const base = { action: 'applyProfile', ...(proj.root ? { projectRoot: proj.root } : {}) };
    const options = fixed ? [] : [{ type: 'select', name: 'profile', label: 'Profile', choices: all.map((p) => ({ value: p.name, label: `${p.name} (${p.skills.length} ${p.skills.length === 1 ? 'skill' : 'skills'})` })) }];
    options.push(
      { type: 'radio', name: 'target', value: 'claude', label: 'Into .claude/skills', hint: 'Visible to Claude in this project.', checked: true },
      { type: 'radio', name: 'target', value: 'agents', label: 'Into .agents/skills', hint: 'Shared with other agents in this project.' },
      { type: 'checkbox', name: 'overwrite', label: 'Overwrite skills already in the project', hint: 'Without this they are skipped. A replaced copy goes to the system Trash.', checked: false });
    const payload = (v) => ({ ...base, profile: fixed || v.profile, target: v.target, overwrite: !!v.overwrite });
    const values = await confirmDialog({
      title: fixed ? `Apply ${fixed} to ${proj.name}` : `Apply a profile to ${proj.name}`,
      lead: 'Copies every skill of the profile into the project. Skills already there are skipped, and names missing from global are reported. Inactive global skills are copied and stay inactive in global.',
      confirmLabel: 'Apply',
      options,
      preview: async (v) => {
        try { return applyPreview(await batchCall({ ...payload(v), dryRun: true })); } catch (e) { return { error: e.message }; }
      },
    });
    if (!values) return;
    let res = null;
    try {
      res = await batchCall(payload(values));
    } catch (e) {
      toast(e.message, 'error');
    }
    if (res) showApplyResults(res, fixed || values.profile, proj.name);
    await refresh();
  }

  function showApplyResults(res, profile, projectName) {
    const results = res.results || [];
    const n = (st) => results.filter((r) => r.status === st).length;
    const copied = n('copied');
    toast(`${profile}: copied ${copied} of ${results.length} into ${projectName}.`, n('failed') ? 'error' : 'info');
    const dlg = $('#results');
    const close = h('button', { class: 'btn primary', type: 'submit', text: 'Close', value: 'close' });
    const parts = [['skipped', 'skipped'], ['missing', 'missing from global'], ['failed', 'failed']].filter(([st]) => n(st)).map(([st, label]) => `${n(st)} ${label}`);
    dlg.replaceChildren(h('form', { method: 'dialog' },
      h('h2', { id: 'results-title', text: `Applied ${profile} to ${projectName}` }),
      h('p', { class: 'lead', text: `Copied ${copied} ${copied === 1 ? 'skill' : 'skills'}${parts.length ? `; ${parts.join(', ')}` : ''}.` }),
      h('ul', { class: 'results' }, results.map((r) => {
        const m = APPLY_STATUS[r.status];
        return h('li', { class: m.cls },
          h('span', { class: `badge ${m.tone}`, text: m.label }),
          h('div', {}, h('strong', { text: r.name }), h('p', { text: applyNote(r) })));
      })),
      h('div', { class: 'modal-actions' }, close)));
    dlg.showModal();
    close.focus();
  }

  // ---------- multi-select and batch copy ----------

  function renderActionBar() {
    const bar = $('#actionbar');
    const on = state.selecting && state.scope === 'global' && !!state.data;
    bar.hidden = !on;
    document.body.classList.toggle('has-bar', on);
    if (!on) return;
    const visible = visibleSkills();
    const allPicked = visible.length > 0 && visible.every((s) => state.selected.has(s.name));
    const n = state.selected.size;
    bar.replaceChildren(
      h('p', { class: 'sel-count', role: 'status' }, h('strong', { text: n }), ` ${n === 1 ? 'skill' : 'skills'} selected`),
      h('div', { class: 'sel-actions' },
        h('button', {
          class: 'btn small', type: 'button', 'data-fk': 'sel-all', disabled: visible.length ? null : true,
          text: allPicked ? `Deselect visible (${visible.length})` : `Select all visible (${visible.length})`,
          onclick: () => {
            for (const s of visible) { if (allPicked) state.selected.delete(s.name); else state.selected.add(s.name); }
            render();
          },
        }),
        h('button', { class: 'btn small primary', type: 'button', 'data-fk': 'sel-copy', disabled: n ? null : true, text: 'Copy to local', onclick: copySelected }),
        h('button', { class: 'btn small ghost', type: 'button', 'data-fk': 'sel-clear', disabled: n ? null : true, text: 'Clear', onclick: () => { state.selected.clear(); render(); } })));
  }

  /** A batch dry run or copy. A partial failure comes back as an error JSON that still carries `results`. */
  async function batchCall(payload) {
    try {
      return await api('/api/action', payload);
    } catch (e) {
      if (e.body && Array.isArray(e.body.results)) return e.body;
      throw e;
    }
  }

  function batchPreview(res, verb = 'will be copied') {
    const results = res.results || [];
    const lines = [];
    for (const r of results) lines.push(r.ok ? { text: `${r.name}: ${verb}` } : { text: `${r.name}: ${r.error || 'will fail'}`, error: true });
    const changes = res.changes || [];
    if (changes.length) {
      lines.push({ text: 'Changes', group: true });
      changes.forEach((c) => lines.push({ text: c }));
    }
    return { lines, blocked: results.length > 0 && results.every((r) => !r.ok) };
  }

  async function copySelected() {
    const names = state.data.global.filter((s) => state.selected.has(s.name)).map((s) => s.name);
    if (!names.length) return;
    const n = names.length;
    const base = { action: 'copyToLocal', scope: 'global', names };
    const inactive = state.data.global.filter((s) => state.selected.has(s.name) && !s.active).length;
    const values = await confirmDialog({
      title: `Copy ${n} ${n === 1 ? 'skill' : 'skills'} to local`,
      lead: `Copies each skill into this project${inactive ? ', including inactive ones (the copies are active)' : ''}. The global copies stay as they are. A skill that fails does not stop the others.`,
      confirmLabel: `Copy ${n} ${n === 1 ? 'skill' : 'skills'}`,
      options: [
        { type: 'radio', name: 'target', value: 'claude', label: 'Into .claude/skills', hint: 'Visible to Claude in this project.', checked: true },
        { type: 'radio', name: 'target', value: 'agents', label: 'Into .agents/skills', hint: 'Shared with other agents in this project.' },
        { type: 'checkbox', name: 'overwrite', label: 'Overwrite local copies', hint: 'Without this, a skill that already exists in this project fails.', checked: false },
      ],
      preview: async (v) => {
        try { return batchPreview(await batchCall({ ...base, dryRun: true, target: v.target, overwrite: !!v.overwrite })); } catch (e) { return { error: e.message }; }
      },
    });
    if (!values) return;
    for (const nm of names) state.busy.add(`global:${nm}`);
    render();
    let res;
    try {
      res = await batchCall({ ...base, target: values.target, overwrite: !!values.overwrite });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      for (const nm of names) state.busy.delete(`global:${nm}`);
    }
    if (res) {
      const results = res.results || [];
      for (const r of results) if (r.ok) state.selected.delete(r.name);
      showResults(results, values);
    }
    await refresh();
  }

  function showResults(results, values) {
    const okN = results.filter((r) => r.ok).length;
    const bad = results.length - okN;
    toast(bad ? `Copied ${okN} of ${results.length}. ${bad} failed.` : `Copied ${okN} ${okN === 1 ? 'skill' : 'skills'} to local.`, bad ? 'error' : 'info');
    const dlg = $('#results');
    const close = h('button', { class: 'btn primary', type: 'submit', text: 'Close', value: 'close' });
    dlg.replaceChildren(h('form', { method: 'dialog' },
      h('h2', { id: 'results-title', text: bad ? `Copied ${okN} of ${results.length}` : `Copied ${okN} ${okN === 1 ? 'skill' : 'skills'}` }),
      h('p', { class: 'lead', text: bad
        ? `${bad} ${bad === 1 ? 'skill was' : 'skills were'} not copied and ${bad === 1 ? 'stays' : 'stay'} selected. Fix the cause, or turn on overwrite, and try again.`
        : `Every skill is now in .${values.target}/skills of this project.` }),
      h('ul', { class: 'results' }, results.map((r) => h('li', { class: r.ok ? 'ok' : 'bad' },
        h('span', { class: `badge ${r.ok ? 'accent' : 'bad'}`, text: r.ok ? 'Copied' : 'Failed' }),
        h('div', {}, h('strong', { text: r.name }), r.ok ? null : h('p', { text: `${r.error || 'Unknown error.'}${r.code ? ` (${r.code})` : ''}` }))))),
      h('div', { class: 'modal-actions' }, close)));
    dlg.showModal();
    close.focus();
  }

  // ---------- wiring ----------

  function setScope(scope) {
    state.scope = scope;
    state.filter = 'all';
    state.selecting = false;
    state.selected.clear();
    render();
    if (scope === 'projects' && !state.projects && !state.projectsLoading) loadProjects();
    if (scope === 'profiles' && !state.profiles) loadProfiles();
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
  $('#select-toggle').addEventListener('click', () => {
    state.selecting = !state.selecting;
    if (!state.selecting) state.selected.clear();
    render();
  });
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
