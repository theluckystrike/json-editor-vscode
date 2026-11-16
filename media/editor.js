// JSON Editor webview: the tree on the left, the form of the selected object on the right. Every change is sent to the
// extension, which edits the text document; the tree redraws from the document. No network, no remote content.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const TYPES = ['string', 'number', 'boolean', 'null', 'object', 'array'];
  const TYPE_LABEL = { string: 'text', number: 'number', boolean: 'true/false', null: 'null', object: 'object', array: 'array' };
  const saved = vscode.getState() || {};
  const S = {
    rows: [], msg: null, expanded: new Set(saved.expanded || []), limits: saved.limits || {}, filter: '', sel: saved.sel || '[]',
    form: null, formOn: saved.formOn !== false, editing: null, readOnly: false, pendingEdit: null, drag: null,
  };
  window.__jsonEditor = S;
  const save = () => vscode.setState({ expanded: [...S.expanded].slice(0, 5000), limits: S.limits, sel: S.sel, formOn: S.formOn });
  const parse = (p) => { try { return JSON.parse(p); } catch (e) { return []; } };
  const parentKey = (p) => JSON.stringify(parse(p).slice(0, -1));
  const request = (extra = {}) => vscode.postMessage({ type: 'view', expanded: [...S.expanded], limits: S.limits, filter: S.filter, ...extra });

  // ---------- rows ----------
  function valHtml(r) {
    if (r.t === 'object') return `<span class="meta">{${r.n}}</span>`;
    if (r.t === 'array') return `<span class="meta">[${r.n}]</span>`;
    if (r.t === 'string') return `<span class="val t-string" title="Double-click to edit">"${esc(r.v)}${r.cut ? '…' : ''}"</span>`;
    return `<span class="val t-${r.t}" title="Double-click to edit">${esc(r.v)}</span>`;
  }
  function keyHtml(r) {
    if (r.k === null || r.k === undefined) return `<span class="key k-root">${S.msg && S.msg.json5 ? 'JSON5' : 'JSON'}</span>`;
    if (typeof r.k === 'number') return `<span class="key k-index">${r.k}</span>`;
    return `<span class="key k-name" title="Double-click to rename">${esc(r.k)}</span>`;
  }
  function rowHtml(r, i) {
    if (r.more) return `<div class="row more" data-i="${i}" data-pad="${r.d * 16 + 8}"><a href="#" class="showMore">Show ${Math.min(200, r.more)} more</a> <span class="muted">(${r.more} not shown)</span></div>`;
    const box = r.t === 'object' || r.t === 'array';
    const tw = box ? `<span class="tw" aria-hidden="true">${r.open ? '▾' : '▸'}</span>` : '<span class="tw"></span>';
    const cls = ['row', r.p === S.sel ? 'sel' : '', r.m ? 'match' : ''].join(' ');
    return `<div class="${cls}" data-i="${i}" role="treeitem" aria-level="${r.d + 1}"${box ? ` aria-expanded="${r.open ? 'true' : 'false'}"` : ''} draggable="${r.d > 0 && !r.dup && !S.readOnly && !S.filter ? 'true' : 'false'}" data-pad="${r.d * 16 + 4}">${tw}${keyHtml(r)}<span class="colon">${r.d > 0 || box ? ':' : ''}</span>${valHtml(r)}${r.dup ? '<span class="dupnote">repeated key: JSON readers use the last one</span>' : ''}<span class="acts"></span><span class="ln" title="Show line ${r.line} in the text editor">${r.line}</span></div>`;
  }
  function actsHtml(r) {
    if (S.readOnly || (S.msg && S.msg.errorCount) || r.dup) return '';
    const box = r.t === 'object' || r.t === 'array';
    const opts = TYPES.map((t) => `<option value="${t}"${t === r.t ? ' selected' : ''}>${TYPE_LABEL[t]}</option>`).join('');
    return `<select class="type" title="Change the type" aria-label="Type">${opts}</select>`
      + (box ? `<button class="act" data-a="add" title="Add an entry inside (Insert)">+ Add</button>` : '')
      + (r.d > 0 ? `<button class="act" data-a="duplicate" title="Duplicate (Ctrl+D)">Duplicate</button><button class="act" data-a="delete" title="Delete (Delete key)">Delete</button>` : '');
  }
  function render() {
    if (S.editing) { S.needRender = true; return; }
    S.needRender = false;
    const html = S.rows.map(rowHtml).join('');
    $('rows').innerHTML = html;
    // indent through the CSS object model: the page CSP allows no inline style attributes
    for (const el of $('rows').children) el.style.paddingLeft = el.dataset.pad + 'px';
    const r = selRow();
    if (r) placeActs();
  }
  function rowEl(i) { return $('rows').querySelector(`.row[data-i="${i}"]`); }
  function selIndex() { return S.rows.findIndex((r) => r.p === S.sel && !r.more); }
  function selRow() { const i = selIndex(); return i >= 0 ? S.rows[i] : null; }
  function placeActs() {
    for (const a of $('rows').querySelectorAll('.acts')) a.innerHTML = '';
    const i = selIndex();
    if (i < 0) return;
    const el = rowEl(i);
    if (!el) return;
    el.querySelector('.acts').innerHTML = actsHtml(S.rows[i]);
  }
  function select(i, opts = {}) {
    const r = S.rows[i];
    if (!r || r.more) return;
    const old = $('rows').querySelector('.row.sel');
    if (old) old.classList.remove('sel');
    S.sel = r.p;
    const el = rowEl(i);
    if (el) { el.classList.add('sel'); if (opts.scroll !== false) el.scrollIntoView({ block: 'nearest' }); }
    placeActs();
    save();
    vscode.postMessage({ type: 'select', p: r.p });
  }
  function toggle(i, open) {
    const r = S.rows[i];
    if (!r || !(r.t === 'object' || r.t === 'array')) return;
    if (S.filter) return;
    const want = open === undefined ? !r.open : open;
    if (r.d === 0 && !want) return;
    if (want) S.expanded.add(r.p); else S.expanded.delete(r.p);
    save();
    request({ keepScroll: true });
  }

  // ---------- inline editing ----------
  function startEdit(i, what) {
    const r = S.rows[i];
    if (!r || r.more || r.dup || S.readOnly || (S.msg && S.msg.errorCount)) return;
    const el = rowEl(i);
    if (!el) return;
    let target, value;
    if (what === 'key') {
      if (typeof r.k !== 'string') return;
      target = el.querySelector('.key');
      value = r.k;
    } else {
      if (r.t === 'object' || r.t === 'array') return;
      if (r.cut) { note('This text is too long to edit here. Use the Text button.'); return; }
      target = el.querySelector('.val');
      value = r.v;
    }
    if (!target) return;
    const inp = document.createElement('input');
    inp.className = 'edit';
    inp.value = value;
    inp.setAttribute('aria-label', what === 'key' ? 'Key' : 'Value');
    inp.style.width = Math.min(600, Math.max(80, value.length * 8 + 30)) + 'px';
    target.replaceWith(inp);
    S.editing = { i, what, p: r.p, t: r.t, inp, old: value };
    inp.focus();
    inp.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = inp.value;
      S.editing = null;
      if (commit && v !== value) {
        if (what === 'key') vscode.postMessage({ type: 'op', op: 'rename', p: r.p, key: v });
        else vscode.postMessage({ type: 'op', op: 'set', p: r.p, value: v, asString: r.t === 'string' });
      }
      // rows that came in while typing are drawn now
      if (S.deferredRows) { const d = S.deferredRows; S.deferredRows = null; applyRows(d); } else render();
      $('main').focus();
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  // ---------- form ----------
  function renderForm() {
    const f = S.form;
    const box = $('form');
    document.body.classList.toggle('form-off', !S.formOn);
    $('formBtn').classList.toggle('on', S.formOn);
    $('formBtn').setAttribute('aria-pressed', String(S.formOn));
    if (!S.formOn || !f) { box.innerHTML = ''; return; }
    const where = parse(f.p);
    const title = where.length ? where.map((k) => (typeof k === 'number' ? `[${k}]` : k)).join(' › ') : 'Top level';
    const ro = S.readOnly || S.formRO;
    let h = `<div class="ftitle" title="${esc(title)}">${esc(title)} <span class="muted">${f.t === 'array' ? 'array' : f.t === 'object' ? 'object' : ''}</span></div>`;
    if (!f.fields.length) h += `<div class="muted fempty">${f.t === 'object' || f.t === 'array' ? 'Empty. Use + Add in the tree.' : 'Select an object or array in the tree.'}</div>`;
    h += '<div class="fgrid">';
    for (const x of f.fields) {
      const label = typeof x.k === 'number' ? `[${x.k}]` : esc(x.k);
      let input;
      if (x.t === 'object' || x.t === 'array') input = `<a href="#" class="fopen" data-p="${esc(x.p)}">${x.t === 'object' ? `{${x.n}} object` : `[${x.n}] array`}: open</a>`;
      else if (x.t === 'boolean') input = `<label class="fbool"><input type="checkbox" data-p="${esc(x.p)}" data-t="boolean"${x.v === 'true' ? ' checked' : ''}${ro ? ' disabled' : ''}> ${x.v}</label>`;
      else if (x.t === 'null') input = `<input type="text" class="finput t-null" data-p="${esc(x.p)}" data-t="null" value="null" placeholder="null"${ro ? ' readonly' : ''}>`;
      else if (x.cut) input = `<span class="muted">Text of ${x.cut} characters: edit it in the text editor.</span>`;
      else input = `<input type="text" class="finput t-${x.t}" data-p="${esc(x.p)}" data-t="${x.t}" value="${esc(x.v)}"${x.t === 'number' ? ' inputmode="decimal"' : ''}${ro ? ' readonly' : ''}>`;
      h += `<label class="flabel${x.p === f.sel ? ' fsel' : ''}" title="${esc(String(x.k))}">${label}</label><div class="ffield">${input}<span class="ftype">${TYPE_LABEL[x.t]}</span></div>`;
    }
    h += '</div>';
    if (f.more) h += `<div class="muted">${f.more} more entries are not shown in the form.</div>`;
    box.innerHTML = h;
  }
  $('form').addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t || !t.dataset || !t.dataset.p) return;
    if (t.type === 'checkbox') vscode.postMessage({ type: 'op', op: 'set', p: t.dataset.p, value: t.checked ? 'true' : 'false', asString: false });
    else if (t.classList.contains('finput')) {
      if (t.dataset.t === 'number' && !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t.value.trim())) { t.classList.add('bad'); note(`"${t.value}" is not a number. Change the type in the tree to store text.`); return; }
      t.classList.remove('bad');
      vscode.postMessage({ type: 'op', op: 'set', p: t.dataset.p, value: t.value, asString: t.dataset.t === 'string' });
    }
  });
  $('form').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.classList.contains('finput')) { ev.preventDefault(); ev.target.blur(); } });
  $('form').addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('.fopen');
    if (!a) return;
    ev.preventDefault();
    const p = a.dataset.p;
    const path = parse(p);
    for (let k = 0; k <= path.length; k++) S.expanded.add(JSON.stringify(path.slice(0, k)));
    S.sel = p;
    S.pendingSelect = p;
    save();
    request();
    vscode.postMessage({ type: 'select', p });
  });

  // ---------- status ----------
  function note(t) { $('note').textContent = t ? ' · ' + t : ''; }
  function fmtSize(n) { return n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
  function showStatus(m) {
    const parts = [];
    if (m.errorCount) parts.push(`${m.errorCount} syntax error${m.errorCount === 1 ? '' : 's'}`);
    else if (m.stats) parts.push(`${m.stats.objects} object${m.stats.objects === 1 ? '' : 's'}, ${m.stats.arrays} array${m.stats.arrays === 1 ? '' : 's'}, ${m.stats.values} value${m.stats.values === 1 ? '' : 's'}`);
    parts.push(`${m.lineCount} line${m.lineCount === 1 ? '' : 's'}`, fmtSize(m.size));
    if (m.comments) parts.push('comments kept');
    if (m.readOnly) parts.push('read-only');
    if (m.truncated) parts.push(`first ${S.rows.length} rows shown`);
    $('status').textContent = parts.join(' · ');
    $('matches').textContent = m.filter ? (m.matches ? `${m.matches}${m.truncated ? '+' : ''} match${m.matches === 1 ? '' : 'es'}` : 'No match') : '';
    const b = $('banner');
    if (m.errorCount) {
      b.className = 'error';
      b.hidden = false;
      b.innerHTML = `<b>This file has ${m.errorCount === 1 ? 'a syntax error' : `${m.errorCount} syntax errors`}, so editing is off until it is fixed in the text editor.</b>${m.json5 ? ' JSON5 syntax such as keys without quotes, single quotes or hex numbers is not edited here.' : ''}<ul>${m.errors.map((e) => `<li><a href="#" class="errline" data-line="${e.line}">${esc(e.message)}</a></li>`).join('')}</ul><button id="bannerText">Open the text</button>`;
    } else if (m.empty) {
      b.className = 'info';
      b.hidden = false;
      b.innerHTML = m.readOnly ? 'This file is empty.' : 'This file is empty. Start with <button class="init" data-t="object">an object { }</button> <button class="init" data-t="array">an array [ ]</button>';
    } else { b.hidden = true; b.innerHTML = ''; }
  }

  function applyRows(m) {
    const main = $('main');
    const top = main.scrollTop;
    S.msg = m;
    S.rows = m.rows;
    S.readOnly = !!m.readOnly;
    document.body.classList.toggle('ro', S.readOnly || !!m.errorCount);
    if (m.expanded) { S.expanded = new Set(m.expanded); save(); }
    if (selIndex() < 0 && S.rows.length && !S.pendingSelect) S.sel = S.rows[0].p;
    render();
    showStatus(m);
    if (m.keepScroll) main.scrollTop = top;
    if (S.pendingSelect) { const i = S.rows.findIndex((r) => r.p === S.pendingSelect && !r.more); S.pendingSelect = null; if (i >= 0) select(i); }
    if (S.pendingEdit) {
      const pe = S.pendingEdit;
      const i = S.rows.findIndex((r) => r.p === pe.p && !r.more);
      if (i >= 0) { S.pendingEdit = null; select(i); startEdit(i, pe.what); }
    }
    vscode.postMessage({ type: 'rendered', gen: m.gen, rows: S.rows.length });
  }

  // ---------- messages ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'rows') {
      if (S.editing) { S.deferredRows = m; return; }
      applyRows(m);
    } else if (m.type === 'form') {
      S.form = m.form;
      S.formRO = !!m.readOnly;
      renderForm();
    } else if (m.type === 'done') {
      note('');
      if (m.p) {
        const path = parse(m.p);
        for (let k = 0; k < path.length; k++) S.expanded.add(JSON.stringify(path.slice(0, k)));
        S.sel = m.p;
        save();
        if (m.edit) S.pendingEdit = { p: m.p, what: typeof path[path.length - 1] === 'string' ? 'key' : 'value' };
        request({ keepScroll: true });
      }
    } else if (m.type === 'error') {
      note(m.message);
      render();
    } else if (m.type === 'setFilter') {
      $('search').value = m.filter || '';
      S.filter = m.filter || '';
      request();
    }
  });

  // ---------- events ----------
  $('rows').addEventListener('click', (ev) => {
    const el = ev.target.closest('.row');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (ev.target.closest('.showMore')) {
      ev.preventDefault();
      const r = S.rows[i];
      S.limits[r.p] = (r.shown || 200) + 200;
      save();
      request({ keepScroll: true });
      return;
    }
    if (ev.target.closest('select, input')) return;
    const act = ev.target.closest('.act');
    if (act) { op(act.dataset.a, i); return; }
    if (ev.target.closest('.ln')) { vscode.postMessage({ type: 'reveal', p: S.rows[i].p }); return; }
    if (ev.target.closest('.tw')) { select(i, { scroll: false }); toggle(i); return; }
    select(i, { scroll: false });
  });
  $('rows').addEventListener('dblclick', (ev) => {
    const el = ev.target.closest('.row');
    if (!el || ev.target.closest('.acts, .ln')) return;
    const i = Number(el.dataset.i);
    const r = S.rows[i];
    if (ev.target.closest('.key')) { startEdit(i, 'key'); return; }
    if (ev.target.closest('.val')) { startEdit(i, 'value'); return; }
    if (r && (r.t === 'object' || r.t === 'array')) toggle(i);
  });
  $('rows').addEventListener('change', (ev) => {
    const s = ev.target.closest('select.type');
    if (!s) return;
    const i = selIndex();
    if (i >= 0) vscode.postMessage({ type: 'op', op: 'type', p: S.rows[i].p, t: s.value });
  });
  function op(a, i) {
    const r = S.rows[i];
    if (!r || S.readOnly) return;
    if (a === 'add') { S.expanded.add(r.p); save(); }
    vscode.postMessage({ type: 'op', op: a, p: r.p });
  }
  // drag to reorder inside the same object or array
  $('rows').addEventListener('dragstart', (ev) => {
    const el = ev.target.closest('.row');
    if (!el) return;
    const r = S.rows[Number(el.dataset.i)];
    S.drag = { p: r.p, parent: parentKey(r.p) };
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', r.p); } catch (e) { /* ignore */ }
  });
  const clearDrop = () => { for (const e of $('rows').querySelectorAll('.drop-before, .drop-after')) e.classList.remove('drop-before', 'drop-after'); };
  function dropTarget(ev) {
    const el = ev.target.closest('.row');
    if (!el || !S.drag) return null;
    const r = S.rows[Number(el.dataset.i)];
    if (!r || r.more || parentKey(r.p) !== S.drag.parent || r.p === S.drag.p) return null;
    const b = el.getBoundingClientRect();
    return { el, r, after: ev.clientY > b.top + b.height / 2 };
  }
  $('rows').addEventListener('dragover', (ev) => {
    const t = dropTarget(ev);
    clearDrop();
    if (!t) return;
    ev.preventDefault();
    t.el.classList.add(t.after ? 'drop-after' : 'drop-before');
  });
  $('rows').addEventListener('dragleave', clearDrop);
  $('rows').addEventListener('drop', (ev) => {
    const t = dropTarget(ev);
    clearDrop();
    if (!t) return;
    ev.preventDefault();
    moveTo(S.drag.p, t.r.p, t.after);
    S.drag = null;
  });
  $('rows').addEventListener('dragend', () => { clearDrop(); S.drag = null; });
  /** Moves p before or after the sibling q (positions among the siblings shown). */
  function moveTo(p, q, after) {
    const sib = S.rows.filter((r) => !r.more && parentKey(r.p) === parentKey(p) && r.d === S.rows.find((x) => x.p === p).d);
    const from = sib.findIndex((r) => r.p === p);
    let to = sib.findIndex((r) => r.p === q) + (after ? 1 : 0);
    if (from < to) to--;
    if (from === to) return;
    vscode.postMessage({ type: 'op', op: 'move', p, to });
  }
  window.__jsonEditorMove = moveTo;

  $('main').addEventListener('keydown', (ev) => {
    if (S.editing || (ev.target && /^(SELECT|INPUT|BUTTON)$/.test(ev.target.tagName))) return;
    const i = selIndex();
    const r = S.rows[i];
    const mod = ev.metaKey || ev.ctrlKey;
    const k = ev.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      ev.preventDefault();
      let j = i + (k === 'ArrowDown' ? 1 : -1);
      while (S.rows[j] && S.rows[j].more) j += k === 'ArrowDown' ? 1 : -1;
      if (S.rows[j]) select(j);
    } else if (k === 'Home' || k === 'End') { ev.preventDefault(); select(k === 'Home' ? 0 : S.rows.length - 1); } else if (!r) return;
    else if (k === 'ArrowRight') { ev.preventDefault(); if ((r.t === 'object' || r.t === 'array') && !r.open) toggle(i, true); else if (S.rows[i + 1] && S.rows[i + 1].d > r.d) select(i + 1); } else if (k === 'ArrowLeft') {
      ev.preventDefault();
      if ((r.t === 'object' || r.t === 'array') && r.open && r.d > 0) toggle(i, false);
      else { const pk = parentKey(r.p); const j = S.rows.findIndex((x) => x.p === pk); if (j >= 0) select(j); }
    } else if (k === 'Enter') { ev.preventDefault(); if (r.t === 'object' || r.t === 'array') toggle(i); else startEdit(i, 'value'); } else if (k === 'F2') { ev.preventDefault(); startEdit(i, 'key'); } else if ((k === 'Delete' || (k === 'Backspace' && mod)) && r.d > 0) { ev.preventDefault(); op('delete', i); } else if (mod && (k === 'd' || k === 'D') && r.d > 0) { ev.preventDefault(); op('duplicate', i); } else if (k === 'Insert' && (r.t === 'object' || r.t === 'array')) { ev.preventDefault(); op('add', i); } else if (k === ' ') { ev.preventDefault(); toggle(i); }
  });
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    const inField = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT');
    if (!inField && (ev.metaKey || ev.ctrlKey) && !ev.altKey && (ev.key === 'z' || ev.key === 'Z' || ev.key === 'y')) {
      ev.preventDefault();
      vscode.postMessage({ type: (ev.key === 'y' || ev.shiftKey) ? 'redo' : 'undo' });
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'f' && !ev.shiftKey) { ev.preventDefault(); $('search').focus(); $('search').select(); }
  });
  let qTimer = null;
  $('search').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter = $('search').value.trim(); request(); }, 200); });
  $('search').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { $('search').value = ''; S.filter = ''; request(); } if (ev.key === 'Enter') { clearTimeout(qTimer); S.filter = $('search').value.trim(); request(); } });
  $('expandAll').addEventListener('click', () => { S.filter = ''; $('search').value = ''; request({ all: true }); });
  $('collapseAll').addEventListener('click', () => { S.expanded = new Set(); S.limits = {}; save(); request(); });
  $('formBtn').addEventListener('click', () => { S.formOn = !S.formOn; save(); renderForm(); });
  $('openText').addEventListener('click', () => vscode.postMessage({ type: 'openText' }));
  $('banner').addEventListener('click', (ev) => {
    const init = ev.target.closest('.init');
    if (init) { vscode.postMessage({ type: 'op', op: 'init', p: '[]', t: init.dataset.t }); return; }
    if (ev.target.closest('#bannerText, .errline')) { ev.preventDefault(); vscode.postMessage({ type: 'openText' }); }
  });

  vscode.postMessage({ type: 'ready', state: { expanded: [...S.expanded], limits: S.limits } });
  vscode.postMessage({ type: 'select', p: S.sel });
}());
