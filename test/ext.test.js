'use strict';
// Extension tests with the vscode stub: listing, activation, the tree editor's messages (rows, search, every edit,
// read-only and broken files), the three Pro tools with their free try (one per tool, counted across files and after a
// reload), the webview HTML and the README.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, tableHtml } = require('../src/html');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const SAMPLE = path.join(ROOT, 'samples', 'shop-catalog.jsonc');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
test.after(() => cleanup());

function activate(folder, state) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  s.api = s.ext.activate(s.context);
  s.int = s.ext._internal;
  return s;
}
function tmpWs() {
  const dir = tmpDir('jsoned-ws-');
  fs.copyFileSync(SAMPLE, path.join(dir, 'shop.jsonc'));
  for (const f of ['orders-a.json', 'orders-b.json', 'broken.json', 'settings.json5', 'crlf-tabs.json', 'empty.json']) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
  fs.copyFileSync(path.join(FIX, 'real', 'git-extension-package.json'), path.join(dir, 'git-package.json'));
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify({ zones: [{ zone: 'DE', price: 4.9 }, { zone: 'EU', price: 9.9 }] }, null, 2) + '\n');
  return dir;
}
function fakePanel() {
  let onMsg;
  const posted = [];
  const disposeCbs = [];
  return {
    posted, viewColumn: 1, active: true, disposed: false,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: (f) => { disposeCbs.push(f); return { dispose() {} }; }, reveal() {}, dispose() { this.disposed = true; disposeCbs.forEach((f) => f()); },
    send: (m) => onMsg(m),
  };
}
async function openJson(s, file) {
  const prov = s.int.editors();
  const doc = await s.vscode.workspace.openTextDocument(s.vscode.Uri.file(file));
  const panel = fakePanel();
  await prov.resolveCustomTextEditor(doc, panel);
  panel.send({ type: 'ready' });
  const sess = prov.sessions.get(doc.uri.toString());
  const rows = () => panel.posted.filter((m) => m.type === 'rows').pop();
  const form = () => panel.posted.filter((m) => m.type === 'form').pop().form;
  const op = async (m) => { panel.send({ type: 'op', ...m }); await sess.queue; await tick(10); };
  return { prov, panel, doc, sess, rows, form, op };
}
const proPanel = (s) => [...s.log.info, ...s.log.warn].find((w) => /is part of Zovo Pro/.test(w.text));
const tries = (s) => s.state.get('jsonEditor.proTrial') || {};
const P = (...a) => JSON.stringify(a);

// ---------- package.json and listing ----------
test('listing: display name with the phrase first, 30 characters or less, 5 keywords, engines for Cursor and Windsurf', () => {
  assert.equal(pkg.displayName, 'JSON Editor, Tree & Form View');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('JSON editor'));
  assert.deepEqual(pkg.keywords, ['json editor', 'json', 'json tree', 'json form', 'dark mode']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(`${pkg.publisher}.${pkg.name}`, 'zovo.zovo-json-editor');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/json-editor-vscode');
  assert.deepEqual(pkg.activationEvents, ['onUri']);
});
test('custom editor: *.json, *.jsonc, *.json5 with priority "option" (text stays default); no clash with the Large JSON Viewer', () => {
  assert.deepEqual(pkg.contributes.customEditors.map((c) => [c.viewType, c.selector.map((x) => x.filenamePattern), c.priority]), [['jsonEditor.tree', ['*.json', '*.jsonc', '*.json5'], 'option']]);
  const viewer = path.join(ROOT, '..', 'json-tree-viewer-vscode', 'package.json');
  if (fs.existsSync(viewer)) {
    const v = JSON.parse(fs.readFileSync(viewer, 'utf8'));
    const theirs = new Set([...v.contributes.customEditors.map((c) => c.viewType), ...v.contributes.commands.map((c) => c.command)]);
    for (const c of [...pkg.contributes.customEditors.map((x) => x.viewType), ...pkg.contributes.commands.map((x) => x.command)]) assert.ok(!theirs.has(c), c);
    const titleIcons = (p) => p.contributes.commands.filter((c) => (p.contributes.menus['editor/title'] || []).some((m) => m.command === c.command)).map((c) => c.icon);
    for (const i of titleIcons(pkg)) assert.ok(!titleIcons(v).includes(i), `same title button icon ${i}`);
  }
});
test('every contributed command is registered, every registered jsonEditor command is contributed, no menu has a title', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), `not registered: ${c}`);
  for (const c of s.commands.keys()) if (c.startsWith('jsonEditor.')) assert.ok(contributed.includes(c), `not in package.json: ${c}`);
  const menus = Object.values(pkg.contributes.menus).flat();
  for (const m of menus) { assert.ok(contributed.includes(m.command), `menu names an unknown command: ${m.command}`); assert.equal(m.title, undefined); }
  for (const id of ['table', 'bulk', 'compare']) assert.match(pkg.contributes.commands.find((c) => c.command === `jsonEditor.zovoPro.${id}`).title, /^Zovo Pro: /);
});
test('Explorer and title menus: one backslash before the dot, upper case names match (CONFIG.JSON)', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.ok(!raw.includes('\\\\\\\\.'), 'no doubled backslash');
  for (const m of [...pkg.contributes.menus['explorer/context'], ...pkg.contributes.menus['editor/title']].filter((x) => /resourceFilename/.test(x.when))) {
    const re = /resourceFilename =~ \/(.+?)\/i/.exec(m.when);
    const rx = new RegExp(re[1], 'i');
    assert.ok(rx.test('CONFIG.JSON') && rx.test('a.jsonc') && rx.test('b.json5') && !rx.test('a.jsonl') && !rx.test('json'), m.when);
  }
});
test('activation shows nothing: no message, no panel, no editor', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.opened.length, 0);
  assert.equal(s.log.external.length, 0);
});

// ---------- the tree editor ----------
test('editor: rows, status data and form; opening never writes', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const file = path.join(dir, 'shop.jsonc');
  const before = fs.readFileSync(file, 'utf8');
  const e = await openJson(s, file);
  const r = e.rows();
  assert.equal(r.errorCount, 0);
  assert.equal(r.comments, true);
  assert.deepEqual(r.stats, { objects: 14, arrays: 8, values: 61 });
  assert.equal(r.rows.find((x) => x.k === 'orderIdStart').v, '9007199254740993');
  assert.ok(e.form().fields.some((f) => f.k === 'currency' && f.v === 'EUR'));
  e.panel.send({ type: 'rendered', gen: r.gen, rows: r.rows.length });
  await e.sess.rendered;
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(e.doc.isDirty, false);
});
test('editor: expand, search, select gives the form of the object', async () => {
  const s = activate(tmpWs());
  const e = await openJson(s, path.join(s.vscode.workspace.workspaceFolders[0].uri.fsPath, 'shop.jsonc'));
  e.panel.send({ type: 'view', expanded: [P('contact'), P('contact', 'address')], limits: {}, filter: '' });
  assert.ok(e.rows().rows.find((x) => x.k === 'postcode' && x.v === '10115'));
  e.panel.send({ type: 'view', expanded: [], limits: {}, filter: 'berlin' });
  assert.equal(e.rows().matches, 1);
  assert.equal(e.rows().rows.filter((x) => x.m)[0].p, P('contact', 'address', 'city'));
  e.panel.send({ type: 'select', p: P('products', 2) });
  assert.deepEqual(e.form().fields.map((f) => f.k), ['sku', 'name', 'price', 'stock', 'tags', 'active']);
  e.panel.send({ type: 'select', p: P('products', 2, 'price') });
  assert.equal(e.form().p, P('products', 2));
  assert.equal(e.form().sel, P('products', 2, 'price'));
});
test('editor edits: value, key, add, duplicate, move, type, delete; each one replace, comments kept, undoable', async () => {
  const s = activate(tmpWs());
  const e = await openJson(s, path.join(s.vscode.workspace.workspaceFolders[0].uri.fsPath, 'shop.jsonc'));
  const t = () => e.doc.getText();
  const n0 = s.log.edits.length;
  await e.op({ op: 'set', p: P('name'), value: 'Southwind', asString: true });
  assert.ok(t().includes('"name": "Southwind",'));
  await e.op({ op: 'set', p: P('orderIdStart'), value: '18446744073709551615', asString: false });
  assert.ok(t().includes('"orderIdStart": 18446744073709551615, // larger than 2^53'));
  await e.op({ op: 'rename', p: P('currency'), key: 'currencyCode' });
  assert.ok(t().includes('"currencyCode": "EUR"'));
  await e.op({ op: 'add', p: P('features') });
  assert.ok(t().includes('"newKey": ""'));
  const done = e.panel.posted.filter((m) => m.type === 'done').pop();
  assert.equal(done.p, P('features', 'newKey'));
  assert.equal(done.edit, true);
  await e.op({ op: 'duplicate', p: P('products', 0) });
  assert.equal((t().match(/"sku": "GT-100"/g) || []).length, 2);
  await e.op({ op: 'move', p: P('products', 6), to: 0 });
  assert.ok(t().indexOf('"sku": "PT-550"') < t().indexOf('"sku": "GT-100"'));
  await e.op({ op: 'type', p: P('open'), t: 'string' });
  assert.ok(t().includes('"open": "true"'));
  await e.op({ op: 'delete', p: P('features', 'newsletter') });
  assert.ok(!t().includes('newsletter'));
  assert.equal(s.log.edits.length - n0, 8, 'one WorkspaceEdit per change');
  assert.ok(t().includes('// Demo shop catalog'));
  assert.ok(t().includes('// larger than 2^53'));
  assert.ok(e.doc.isDirty);
  // the tree followed: the last rows message shows the new key
  await tick(10);
  assert.ok(e.rows().rows.find((x) => x.k === 'currencyCode'));
  // an error goes back to the webview, nothing is written
  const before = t();
  await e.op({ op: 'rename', p: P('version'), key: 'name' });
  assert.match(e.panel.posted.filter((m) => m.type === 'error').pop().message, /already used/);
  assert.equal(t(), before);
});
test('editor: a change typed in the text editor redraws the tree', async () => {
  const s = activate(tmpWs());
  const e = await openJson(s, path.join(s.vscode.workspace.workspaceFolders[0].uri.fsPath, 'zones.json'));
  const we = new s.vscode.WorkspaceEdit();
  we.replace(e.doc.uri, new s.vscode.Range(e.doc.positionAt(0), e.doc.positionAt(e.doc.getText().length)), '{ "typed": 42 }');
  await s.vscode.workspace.applyEdit(we);
  await tick(400);
  assert.ok(e.rows().rows.find((x) => x.k === 'typed' && x.v === '42'));
});
test('editor: broken file and JSON5 syntax open read-only with the line of the error; nothing is written', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const e = await openJson(s, path.join(dir, 'broken.json'));
  const r = e.rows();
  assert.ok(r.errorCount >= 1);
  assert.match(r.errors[0].message, /^Line 4, column 3: a comma was expected$/);
  await e.op({ op: 'set', p: P('name'), value: 'x', asString: true });
  assert.match(e.panel.posted.filter((m) => m.type === 'error').pop().message, /syntax error/);
  assert.equal(fs.readFileSync(path.join(dir, 'broken.json'), 'utf8'), e.doc.getText());
  const j5 = await openJson(s, path.join(dir, 'settings.json5'));
  assert.equal(j5.rows().json5, true);
  assert.ok(j5.rows().errorCount > 0);
  const empty = await openJson(s, path.join(dir, 'empty.json'));
  assert.equal(empty.rows().empty, true);
  await empty.op({ op: 'init', p: '[]', t: 'object' });
  assert.equal(empty.doc.getText(), '{}\n');
});
test('editor: CRLF and tabs are kept by an added entry', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const e = await openJson(s, path.join(dir, 'crlf-tabs.json'));
  await e.op({ op: 'add', p: P('list') });
  assert.ok(e.doc.getText().includes('\t\t{ "a": 2 },\r\n\t\t""\r\n\t],'));
});
test('editor: git scheme opens read-only', async () => {
  const s = activate();
  const prov = s.int.editors();
  const doc = s.makeDoc(s.vscode.Uri.parse('git:/x/a.json'), '{"a":1}', 'json');
  const panel = fakePanel();
  await prov.resolveCustomTextEditor(doc, panel);
  panel.send({ type: 'ready' });
  assert.equal(panel.posted.find((m) => m.type === 'rows').readOnly, true);
  panel.send({ type: 'op', op: 'set', p: P('a'), value: '2' });
  await prov.sessions.get(doc.uri.toString()).queue;
  assert.equal(doc.getText(), '{"a":1}');
});

// ---------- Pro: Table mode ----------
async function tableOf(s) {
  const st = [...s.api.tools().tables].pop();
  await tick(10);
  st.panel.send({ type: 'rendered', gen: 1, rows: 1 });
  await st.rendered;
  await tick(5);
  return st;
}
test('Pro table: opens the array of objects, counts the try after it shows; cell edit, new column, CSV export', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'shop.jsonc'));
  s.ui.quick.push((items) => items.find((x) => x.label === '$.products'));
  const st = await s.vscode.commands.executeCommand('jsonEditor.table', uri);
  assert.deepEqual(s.log.lastPick.items.map((x) => x.label), ['$.products', '$.shipping.zones']);
  assert.equal(tries(s).table, undefined, 'not counted before the table showed');
  await tick(10);
  const model = st.panel.posted.find((m) => m.type === 'table').model;
  assert.deepEqual(model.columns, ['sku', 'name', 'price', 'stock', 'tags', 'active']);
  await tableOf(s);
  assert.equal(tries(s).table, 1);
  assert.ok(s.log.status.some((t) => /free try 1 of 1 of "Table mode" used/.test(t)));
  st.panel.send({ type: 'cell', i: 1, col: 'price', value: '19.5', asString: false });
  await tick(20);
  assert.ok(st.doc.getText().includes('"name": "Watering can, 10 l", "price": 19.5,'));
  s.ui.input.push('discount');
  st.panel.send({ type: 'addColumn' });
  await tick(20);
  assert.equal((st.doc.getText().match(/"discount": null/g) || []).length, 6);
  const out = path.join(dir, 'products.csv');
  s.ui.save.push(s.vscode.Uri.file(out));
  st.panel.send({ type: 'exportCsv', order: [5, 4, 3, 2, 1, 0] });
  await tick(30);
  const csv = fs.readFileSync(out, 'utf8').split('\r\n');
  assert.equal(csv[0], 'sku,name,price,stock,tags,active,discount');
  assert.match(csv[1], /^PT-550,"Clay pot, 30 cm",15,48,/);
  assert.equal(tries(s).table, 1, 'edits inside the open table do not count again');
});
test('Pro table: used once on file A, a click for file B opens the Zovo Pro panel and opens no table', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('jsonEditor.table', s.vscode.Uri.file(path.join(dir, 'zones.json')));
  await tableOf(s);
  assert.equal(tries(s).table, 1);
  const n = s.api.tools().tables.size;
  const r = await s.vscode.commands.executeCommand('jsonEditor.table', s.vscode.Uri.file(path.join(dir, 'git-package.json')));
  assert.equal(r, undefined);
  assert.match(proPanel(s).text, /Table mode is part of Zovo Pro/);
  assert.match(proPanel(s).opts.detail, /You used the free try of Table mode on this computer\./);
  assert.equal(s.api.tools().tables.size, n, 'no new table');
});
test('Pro table: a file with no array of objects says so and uses no try', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('jsonEditor.table', s.vscode.Uri.file(path.join(dir, 'crlf-tabs.json')));
  fs.writeFileSync(path.join(dir, 'flat.json'), '{"a": 1}');
  await s.vscode.commands.executeCommand('jsonEditor.table', s.vscode.Uri.file(path.join(dir, 'flat.json')));
  assert.ok(s.log.info.some((m) => /no array of objects/.test(m.text)));
});

// ---------- Pro: Bulk edit ----------
test('Pro bulk: query, action, preview, then one edit; counted after it applied', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'shop.jsonc'));
  s.ui.input.push('$.products[?(@.stock == 0)].active');
  s.ui.quick.push((items) => items.find((x) => x.id === 'set'));
  s.ui.input.push('false');
  let r = await s.vscode.commands.executeCommand('jsonEditor.bulk', uri);
  assert.equal(r.changes, 0, 'the only match is already false: nothing to change, nothing counted');
  assert.ok(s.log.info.some((m) => /Nothing to change: 1 match/.test(m.text)));
  assert.equal(tries(s).bulk, undefined);
  s.ui.input.push('$..price');
  s.ui.quick.push((items) => items.find((x) => x.id === 'rename'));
  s.ui.input.push('cost');
  s.ui.quick.push((items) => items.find((x) => x.apply));
  r = await s.vscode.commands.executeCommand('jsonEditor.bulk', uri);
  assert.equal(r.changes, 9);
  const preview = s.log.lastPick.items;
  assert.match(preview[0].label, /Apply 9 changes/);
  assert.equal(preview[1].label, '$.products[0].price');
  assert.equal(preview[1].description, '"price"  →  "cost"');
  const doc = s.vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  assert.equal((doc.getText().match(/"cost":/g) || []).length, 9);
  assert.ok(doc.getText().includes('// Demo shop catalog'));
  assert.equal(tries(s).bulk, 1);
});
test('Pro bulk: Escape in the preview changes nothing and uses no try; used once on file A, file B opens the Pro panel', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'orders-a.json'));
  const before = fs.readFileSync(a.fsPath, 'utf8');
  s.ui.input.push('$.items[*].qty');
  s.ui.quick.push((items) => items.find((x) => x.id === 'delete'));
  s.ui.quick.push(undefined);
  await s.vscode.commands.executeCommand('jsonEditor.bulk', a);
  assert.equal(tries(s).bulk, undefined);
  assert.equal((await s.vscode.workspace.openTextDocument(a)).getText(), before);
  const r = await s.vscode.commands.executeCommand('jsonEditor.bulk', a, { expr: '$.items[*].qty', action: 'delete', confirm: true });
  assert.equal(r.changes, 2);
  assert.equal(tries(s).bulk, 1);
  const picks = s.log.lastPick;
  const r2 = await s.vscode.commands.executeCommand('jsonEditor.bulk', s.vscode.Uri.file(path.join(dir, 'orders-b.json')));
  assert.equal(r2, undefined);
  assert.match(proPanel(s).text, /Bulk edit by JSONPath is part of Zovo Pro/);
  assert.equal(s.log.lastPick, picks, 'no query box or picker after the Pro panel');
});

// ---------- Pro: Compare and merge ----------
test('Pro compare: report opens, try counted; picked changes are copied into this file only', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'orders-a.json'));
  s.ui.quick.push((items) => items.find((x) => x.label === 'orders-b.json'));
  s.ui.quick.push((items) => items.filter((x) => /customer\.city|\$\.paid/.test(x.label)));
  const r = await s.vscode.commands.executeCommand('jsonEditor.compare', a);
  assert.equal(r.diffs, 6);
  assert.equal(r.copied, 2);
  assert.ok(s.log.opened.some((d) => d.languageId === 'markdown' && /6 differences/.test(d.getText())));
  assert.equal(tries(s).compare, 1);
  const t = (await s.vscode.workspace.openTextDocument(a)).getText();
  assert.ok(t.includes('"city": "Paris"'));
  assert.ok(t.includes('"paid": true'));
  assert.ok(t.includes('"version": "1.0"'), 'unpicked changes stay');
  assert.equal(fs.readFileSync(path.join(dir, 'orders-b.json'), 'utf8'), fs.readFileSync(path.join(FIX, 'orders-b.json'), 'utf8'));
});
test('Pro compare: used once on file A, a click for file B opens the Zovo Pro panel and no picker', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('jsonEditor.compare', s.vscode.Uri.file(path.join(dir, 'orders-a.json')), { other: s.vscode.Uri.file(path.join(dir, 'orders-b.json')), pick: [] });
  assert.equal(tries(s).compare, 1);
  const picks = s.log.lastPick;
  const r = await s.vscode.commands.executeCommand('jsonEditor.compare', s.vscode.Uri.file(path.join(dir, 'zones.json')));
  assert.equal(r, undefined);
  assert.match(proPanel(s).text, /Compare and merge is part of Zovo Pro/);
  assert.equal(s.log.lastPick, picks);
});
test('Pro compare: a broken file stops with the reason and uses no try', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('jsonEditor.compare', s.vscode.Uri.file(path.join(dir, 'orders-a.json')), { other: s.vscode.Uri.file(path.join(dir, 'broken.json')) });
  assert.ok(s.log.error.some((m) => /other file has a syntax error/.test(m.text)));
  assert.equal(tries(s).compare, undefined);
});

// ---------- tries ----------
test('free tries: one per tool in ONE constant (pro.js), not set in the proinfo JSON; the toolbar row says "1 free try"', () => {
  const pro = require('../src/pro');
  assert.equal(pro.TRIAL_USES, 1);
  assert.equal(pro.TRIAL_KEY, 'jsonEditor.proTrial');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'pro.js'), 'utf8');
  assert.equal((src.match(/TRIAL_USES = /g) || []).length, 1);
  const cfg = require('../src/license/config');
  assert.equal(cfg.listing, 'jsoned');
  assert.equal(cfg.pro_info.triesKey, 'jsonEditor.proTrial');
  assert.equal(cfg.pro_info.triesMax, undefined);
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.id), ['table', 'bulk', 'compare']);
  const s = activate();
  const row = s.int.editors().hooks.reach.rowHtml();
  assert.match(row, /Table mode/);
  assert.match(row, /1 free try/);
});
test('free tries survive a reload: a new activation with the same stored state opens the Pro panel for a used tool', async () => {
  const dir = tmpWs();
  const s = activate(dir, [['jsonEditor.proTrial', { bulk: 1 }]]);
  const r = await s.vscode.commands.executeCommand('jsonEditor.bulk', s.vscode.Uri.file(path.join(dir, 'shop.jsonc')));
  assert.equal(r, undefined);
  assert.match(proPanel(s).text, /Bulk edit by JSONPath is part of Zovo Pro/);
  assert.match(proPanel(s).opts.detail, /Table mode: 0 of 1 free try used/);
});
test('free tries: the count never goes down in a session even if the stored value reads stale', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('jsonEditor.bulk', s.vscode.Uri.file(path.join(dir, 'orders-a.json')), { expr: '$.note', action: 'upper', confirm: true });
  s.state.set('jsonEditor.proTrial', {});
  assert.equal(s.api.pro().left('bulk'), 0);
});

// ---------- HTML ----------
test('webview HTML: CSP default-src none, nonce scripts only, no remote origin', () => {
  for (const h of [editorHtml({ cspSource: 'vscode-resource:', media: (n) => `vscode-resource:/media/${n}`, nonce: 'abc' }), tableHtml({ cspSource: 'vscode-resource:', media: (n) => `vscode-resource:/media/${n}`, nonce: 'abc' })]) {
    assert.match(h, /default-src 'none'/);
    assert.match(h, /script-src 'nonce-abc'/);
    assert.doesNotMatch(h, /https?:\/\/(?!marketplace\.visualstudio\.com|open-vsx\.org)/);
    for (const m of h.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /nonce="abc"/);
  }
  const media = fs.readFileSync(path.join(ROOT, 'media', 'editor.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'media', 'table.js'), 'utf8');
  assert.doesNotMatch(media, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
});

// ---------- README and text ----------
test('README: first screen has the main use, a screenshot of this product, the free list and the price; by Zovo; no rival names', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 30).join('\n');
  assert.match(first, /^# JSON Editor, Tree & Form View/);
  assert.match(first, /\(images\/screenshot\.png\)/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/);
  assert.doesNotMatch(md, /nickdemayo|chamblin|jy-xlj|vscode-json-editor|jsoneditoronline|josdejong/i);
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
  assert.ok(!fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').some((l) => /^images/.test(l)));
});
test('support links name this listing; walkthrough cross-sells existing listings only', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-json-editor');
  assert.ok(!support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'jsonEditor.getPro');
  const step = pkg.contributes.walkthroughs[0].steps.find((x) => x.id === 'zovo-related');
  const ids = [...step.description.matchAll(/command:extension\.open\?%5B%22([^%]+)%22%5D/g)].map((x) => x[1]);
  assert.deepEqual(ids, ['zovo.zovo-json-tree-viewer', 'zovo.zovo-jsonl-viewer', 'zovo.zovo-csv-viewer']);
  const products = path.join(ROOT, '..');
  const known = new Set(fs.readdirSync(products).map((d) => { try { const p = JSON.parse(fs.readFileSync(path.join(products, d, 'package.json'), 'utf8')); return `${p.publisher}.${p.name}`; } catch (e) { return ''; } }));
  for (const id of ids) assert.ok(known.has(id), id);
});
