// Table mode webview (Zovo Pro): one row per item of an array of objects, one column per key. Sorting and the filter
// change only the view; a cell edit goes to the extension, which edits the JSON text. No network, no remote content.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const S = { m: null, sort: null, dir: 1, filter: '', order: [], readOnly: false, gen: 0 };
  window.__jsonTable = S;

  function cmp(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    if (a.t === 'number' && b.t === 'number') return Number(a.v) - Number(b.v);
    return String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: 'base' });
  }
  function visible() {
    const m = S.m;
    let rows = m.rows.slice();
    const q = S.filter.toLowerCase();
    if (q) rows = rows.filter((r) => Object.values(r.cells).some((c) => c && String(c.v).toLowerCase().includes(q)) || (r.other && String(r.other.v).toLowerCase().includes(q)));
    if (S.sort !== null) rows.sort((x, y) => S.dir * cmp(x.cells[S.sort], y.cells[S.sort]) || x.i - y.i);
    return rows;
  }
  function render() {
    const m = S.m;
    if (!m) return;
    $('where').textContent = m.where;
    const head = `<tr><th class="idx">#</th>${m.columns.map((c) => `<th data-c="${esc(c)}" title="Sort by ${esc(c)}">${esc(c)}${S.sort === c ? (S.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
    const rows = visible();
    S.order = rows.map((r) => r.i);
    const body = rows.map((r) => {
      if (!r.obj) return `<tr data-i="${r.i}"><td class="idx">${r.i + 1}</td><td class="nested" colspan="${Math.max(1, m.columns.length)}">${esc(r.other ? r.other.v : '')} (not an object)</td></tr>`;
      return `<tr data-i="${r.i}"><td class="idx">${r.i + 1}</td>${m.columns.map((c) => {
        const x = r.cells[c];
        if (!x) return `<td class="cell missing" data-c="${esc(c)}"></td>`;
        if (x.t === 'object' || x.t === 'array') return `<td class="nested" data-c="${esc(c)}">${esc(x.v)}</td>`;
        return `<td class="cell t-${x.t}" data-c="${esc(c)}">${esc(x.v)}</td>`;
      }).join('')}</tr>`;
    }).join('');
    $('grid').querySelector('thead').innerHTML = head;
    $('grid').querySelector('tbody').innerHTML = body;
    $('status').textContent = `${rows.length} of ${m.total} row${m.total === 1 ? '' : 's'} · ${m.columns.length} column${m.columns.length === 1 ? '' : 's'}${m.truncated ? ` · first ${m.rows.length} rows` : ''}${S.readOnly ? ' · read-only' : ''}`;
  }
  function edit(td) {
    if (S.readOnly || !td || td.querySelector('input')) return;
    const tr = td.closest('tr');
    const i = Number(tr.dataset.i), c = td.dataset.c;
    const row = S.m.rows.find((r) => r.i === i);
    const cur = row && row.cells[c];
    const inp = document.createElement('input');
    inp.className = 'edit';
    inp.value = cur ? cur.v : '';
    td.textContent = '';
    td.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit && inp.value !== (cur ? cur.v : '')) vscode.postMessage({ type: 'cell', i, col: c, value: inp.value, asString: !!cur && cur.t === 'string' });
      else render();
    };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); } });
    inp.addEventListener('blur', () => finish(true));
  }
  $('grid').addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-c]');
    if (!th) return;
    const c = th.dataset.c;
    if (S.sort === c) { if (S.dir > 0) S.dir = -1; else { S.sort = null; S.dir = 1; } } else { S.sort = c; S.dir = 1; }
    render();
  });
  $('grid').addEventListener('dblclick', (ev) => edit(ev.target.closest('td.cell')));
  let t = null;
  $('filter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.filter = $('filter').value.trim(); render(); }, 150); });
  $('addColumn').addEventListener('click', () => vscode.postMessage({ type: 'addColumn' }));
  $('exportCsv').addEventListener('click', () => vscode.postMessage({ type: 'exportCsv', order: S.order }));
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'table') {
      S.m = m.model; S.readOnly = !!m.readOnly; S.gen = m.gen;
      if (S.sort !== null && !S.m.columns.includes(S.sort)) S.sort = null;
      $('banner').hidden = !m.error;
      $('banner').className = m.error ? 'error' : '';
      $('banner').textContent = m.error || '';
      render();
      vscode.postMessage({ type: 'rendered', gen: m.gen, rows: S.order.length, columns: S.m.columns.length });
    } else if (m.type === 'note') { $('note').textContent = m.text ? ' · ' + m.text : ''; }
  });
  vscode.postMessage({ type: 'ready' });
}());
