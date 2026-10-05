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

  async function api(path, body) {
    const opts = body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
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
  }

  const skillsOf = (scope) => (state.data ? state.data[scope] || [] : []);
  const problems = (skills) => skills.filter((s) => s.status !== 'ok');
  const fixAllTargets = () => skillsOf('global').filter((s) => FIXABLE.has(s.status) && s.status !== 'diverged');

  // ---------- rendering ----------

  function render() {
    const focusKey = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.fk : null;
    renderHeader();
    renderBanner();
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

  function renderBanner() {
    const el = $('#banner');
    if (!state.data) { el.hidden = true; return; }
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
    ];
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
    if (f.startsWith('status:')) return s.status === f.slice(7);
    return true;
  }

  function renderChips() {
    const box = $('#chips');
    const defs = chipDefs(skillsOf(state.scope));
    if (!defs.some((c) => c.id === state.filter)) state.filter = 'all';
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
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!shown.length) {
      list.append(all.length
        ? emptyState('No matching skills', 'Try a different search or clear the status filter.')
        : emptyState(state.scope === 'local' ? 'No local skills yet' : 'No global skills yet',
          state.scope === 'local'
            ? 'Copy a global skill into this project to see it here.'
            : 'Promote a local skill to make it available everywhere.'));
      return;
    }
    list.append(...shown.map(card));
  }

  function emptyState(title, text) {
    return h('div', { class: 'empty-state' }, h('h2', { text: title }), h('p', { text }));
  }

  function badge(status) {
    const m = STATUS[status] || { label: status, tone: 'plain' };
    return h('span', { class: `badge ${m.tone}`, text: m.label });
  }

  function card(s) {
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
            has(other) ? h('span', { class: 'badge also', text: `Also ${other}` }) : null)),
        h('button', {
          class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(s.active),
          'aria-label': `${s.active ? 'Deactivate' : 'Activate'} ${s.name}`, 'data-fk': `sw:${k}`,
          title: s.active ? 'Active. Click to deactivate.' : 'Inactive. Click to activate.',
          onclick: () => toggle(s),
        })),
      h('p', { class: `desc${s.description ? '' : ' empty'}`, text: s.description || 'No description in SKILL.md.' }),
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
  function confirmDialog({ title, lead = '', confirmLabel = 'Confirm', danger = false, options = [], preview }) {
    const dlg = $('#confirm');
    const optBox = $('#confirm-options');
    const prev = $('#confirm-preview');
    const ok = $('#confirm-ok');
    $('#confirm-title').textContent = title;
    $('#confirm-lead').textContent = lead;
    ok.textContent = confirmLabel;
    ok.className = `btn primary${danger ? ' danger solid' : ''}`;
    optBox.replaceChildren();

    const values = {};
    const radios = new Map();
    for (const o of options) {
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

  async function perform(skill, payload, { quiet = false } = {}) {
    const k = skill ? key(skill) : null;
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

  async function promote(s) {
    const base = { action: 'promote', scope: 'local', name: s.name };
    const exists = (s.alsoIn || []).includes('global');
    const values = await confirmDialog({
      title: `Promote ${s.name} to global`,
      lead: 'Copies this skill to your global store and links it for Claude. The local copy stays.',
      confirmLabel: 'Promote',
      options: [{ type: 'checkbox', name: 'overwrite', label: 'Overwrite the global copy', hint: 'A global skill with this name already exists.', checked: false }]
        .filter(() => exists),
      preview: async (v) => previewOf(await safeDry({ ...base, overwrite: !!v.overwrite })),
    });
    if (values) await perform(s, { ...base, overwrite: !!values.overwrite });
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

  async function remove(s) {
    const base = { action: 'delete', scope: s.scope, name: s.name };
    const ok = await confirmDialog({
      title: `Delete ${s.name}`,
      lead: `Moves the ${s.scope} skill to the trash folder. You can restore it from there by hand.`,
      confirmLabel: 'Move to trash',
      danger: true,
      preview: async () => previewOf(await safeDry(base)),
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
          fact(fmtDate(sk.mtime) || 'unknown', 'modified')),
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

  const fact = (value, label) => h('div', { class: 'fact' }, h('b', { text: value }), h('span', { text: label }));

  // ---------- wiring ----------

  function setScope(scope) {
    state.scope = scope;
    state.filter = 'all';
    render();
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setScope(tab.dataset.scope));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = tab.dataset.scope === 'global' ? 'local' : 'global';
      setScope(next);
      $(`#tab-${next}`).focus();
    });
  });

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
