'use strict';
// Core tests without VS Code: parsing and rows, every tree edit (only the edited text changes), JSONPath, bulk edit,
// compare and merge, table mode and CSV, on our fixtures and on real files from microsoft/vscode and JSONTestSuite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const J = require('../src/core/jdoc');
const P = require('../src/core/jsonpath');
const B = require('../src/core/bulk');
const D = require('../src/core/diff');
const T = require('../src/core/table');

const FIX = path.join(__dirname, 'fixtures');
const SAMPLE = path.join(__dirname, '..', 'samples', 'shop-catalog.jsonc');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const sample = () => fs.readFileSync(SAMPLE, 'utf8');
/** a and b differ only inside one span that covers at most `max` characters of a. */
function onlySpan(a, b, max) {
  const e = J.minimalEdit(a, b);
  assert.ok(e, 'something changed');
  assert.ok(e.end - e.start <= max, `changed span ${e.end - e.start} > ${max}: ${JSON.stringify(a.slice(e.start, e.end))} -> ${JSON.stringify(e.text)}`);
  return e;
}

test('parse: comments and trailing commas are fine, the sample has no error and keeps its 64-bit number text', () => {
  const d = J.parse(sample());
  assert.equal(d.errors.length, 0);
  assert.ok(d.hasComments);
  const rows = J.buildRows(d, {}).rows;
  const id = rows.find((r) => r.k === 'orderIdStart');
  assert.equal(id.v, '9007199254740993');
  assert.equal(id.t, 'number');
  assert.equal(rows[0].t, 'object');
  assert.equal(rows[0].open, true);
  assert.ok(rows.find((r) => r.k === 'products' && r.n === 6 && r.open === false));
});

test('parse: errors have line, column and a plain message; JSON5 syntax is reported, not guessed', () => {
  const b = J.parse(read('broken.json'));
  assert.ok(b.errors.length >= 1);
  assert.equal(b.errors[0].line, 4);
  assert.match(b.errors[0].message, /^Line 4, column 3: a comma was expected$/);
  const j5 = J.parse(read('settings.json5'));
  assert.ok(j5.errors.some((e) => /key in double quotes/.test(e.message)));
  const n = J.parse(read('real/n_structure_unclosed_array.json'));
  assert.match(n.errors[0].message, /closing \] was expected/);
  assert.equal(J.parse('').empty, true);
  assert.equal(J.parse('').errors.length, 0);
});

test('rows: expanded containers, PAGE children then a "more" row, limits raise it, all expands everything', () => {
  const big = JSON.stringify({ list: Array.from({ length: 450 }, (_, i) => ({ i })) }, null, 1);
  const d = J.parse(big);
  const r1 = J.buildRows(d, { expanded: [J.pkey(['list'])] });
  assert.equal(r1.rows.filter((r) => r.d === 2 && !r.more).length, J.PAGE);
  const more = r1.rows.find((r) => r.more);
  assert.equal(more.more, 250);
  const r2 = J.buildRows(d, { expanded: [J.pkey(['list'])], limits: { [J.pkey(['list'])]: 400 } });
  assert.equal(r2.rows.filter((r) => r.d === 2 && !r.more).length, 400);
  const r3 = J.buildRows(J.parse(sample()), { all: true });
  assert.ok(r3.rows.find((r) => r.k === 'postcode'));
  assert.ok(r3.expanded.includes(J.pkey(['contact', 'address'])));
});

test('search: matches keys and values case-insensitively and brings their parents', () => {
  const d = J.parse(sample());
  const r = J.searchRows(d, 'watering');
  assert.equal(r.matches, 3);
  assert.deepEqual(r.rows.filter((x) => x.m).map((x) => x.p), [J.pkey(['products', 1, 'name']), J.pkey(['products', 1, 'tags', 0]), J.pkey(['products', 3, 'tags', 0])]);
  assert.ok(r.rows.find((x) => x.p === J.pkey(['products'])));
  const k = J.searchRows(d, 'POSTCODE');
  assert.equal(k.matches, 1);
  assert.equal(J.searchRows(d, 'nothing-like-this').rows.length, 0);
});

test('edit value: only the value text changes; strings stay strings, numbers stay exact, other text becomes a string', () => {
  const t = sample();
  const d = J.parse(t);
  const a = J.setValue(d, ['name'], 'North "Garden"', true);
  onlySpan(t, a, 25);
  assert.ok(a.includes('"name": "North \\"Garden\\"",'));
  const b = J.setValue(d, ['orderIdStart'], '18446744073709551615', false);
  assert.ok(b.includes('"orderIdStart": 18446744073709551615, // larger than 2^53'));
  const c = J.setValue(d, ['products', 0, 'price'], 'twelve', false);
  assert.ok(c.includes('"price": "twelve"'));
  assert.throws(() => J.setValue(d, ['contact'], 'x', true), /Only a text, number/);
  assert.equal(J.setValue(d, ['open'], 'false', false).replace('"open": false', '"open": true'), t);
});

test('rename key, delete, add, duplicate: comments and the rest of the file stay', () => {
  const t = sample();
  const d = J.parse(t);
  const r = J.renameKey(d, ['currency'], 'currencyCode');
  onlySpan(t, r, 10);
  assert.throws(() => J.renameKey(d, ['currency'], 'name'), /already used/);
  const del = J.remove(d, ['open']);
  assert.ok(!/"open"/.test(del));
  assert.ok(del.includes('// Demo shop catalog'));
  assert.ok(del.includes('// larger than 2^53'));
  assert.equal(J.parse(del).errors.length, 0);
  const add = J.addChild(d, ['features']);
  assert.deepEqual(add.path, ['features', 'newKey']);
  assert.ok(add.text.includes('"newsletter": null,\n    "newKey": ""\n  }'));
  const add2 = J.addChild(J.parse(add.text), ['features']);
  assert.deepEqual(add2.path, ['features', 'newKey 2']);
  const dup = J.duplicate(d, ['products', 1]);
  assert.deepEqual(dup.path, ['products', 2]);
  const dd = J.parse(dup.text);
  assert.equal(J.childCount(dd.at(['products'])), 7);
  assert.equal(dd.at(['products', 2, 'sku']).value, 'WC-220');
  const dupObj = J.duplicate(d, ['contact']);
  assert.deepEqual(dupObj.path, ['contact copy']);
  assert.equal(J.parse(dupObj.text).at(['contact copy', 'address', 'city']).value, 'Berlin');
  assert.throws(() => J.remove(d, []), /top value/);
});

test('inline arrays stay inline, multi-line ones stay multi-line, tabs and CRLF are kept', () => {
  const t = '{ "a": [1, 2, 3], "b": {} }';
  const d = J.parse(t);
  assert.equal(J.remove(d, ['a', 1]), '{ "a": [1, 3], "b": {} }');
  assert.equal(J.remove(d, ['a', 2]), '{ "a": [1, 2], "b": {} }');
  assert.equal(J.addChild(d, ['a']).text, '{ "a": [1, 2, 3, ""], "b": {} }');
  assert.equal(J.move(d, ['a', 0], 2).text, '{ "a": [2, 3, 1], "b": {} }');
  const c = read('crlf-tabs.json');
  const cd = J.parse(c);
  const added = J.addChild(cd, ['list']).text;
  assert.ok(added.includes('{ "a": 2 },\r\n\t\t""\r\n\t]'), JSON.stringify(added));
  assert.ok(!/[^\r]\n/.test(added), 'no bare LF');
  const moved = J.move(cd, ['name'], 0).text;
  assert.ok(moved.startsWith('{\r\n\t"name": "tabs and CRLF",\r\n\t"id": 12345678901234567890,'), JSON.stringify(moved));
  assert.equal(J.parse(moved).errors.length, 0);
});

test('move: arrays and objects, both directions; drag positions are among the siblings', () => {
  const d = J.parse(sample());
  const m = J.move(d, ['products', 5], 0);
  assert.equal(J.parse(m.text).at(['products', 0, 'sku']).value, 'PT-550');
  assert.deepEqual(m.path, ['products', 0]);
  const o = J.move(d, ['features'], 0);
  const keys = J.entries(J.parse(o.text).root).map(([k]) => k);
  assert.equal(keys[0], 'features');
  assert.equal(keys.length, 9);
  assert.equal(J.move(d, ['name'], 0).text, d.text);
});

test('change type keeps what can be kept', () => {
  const d = J.parse('{"s":"12","n":3,"b":true,"z":null,"o":{"a":1},"t":"[1,2]","w":"yes"}');
  const get = (text, k) => J.parse(text).at([k]);
  assert.equal(get(J.changeType(d, ['s'], 'number'), 's').type, 'number');
  assert.equal(J.changeType(d, ['n'], 'string').includes('"n":"3"'), true);
  assert.equal(J.changeType(d, ['b'], 'number').includes('"b":1'), true);
  assert.equal(J.changeType(d, ['w'], 'boolean').includes('"w":true'), true);
  assert.equal(J.changeType(d, ['z'], 'object').includes('"z":{}'), true);
  assert.equal(J.changeType(d, ['t'], 'array').includes('"t":[1,2]'), true);
  assert.equal(J.changeType(d, ['n'], 'array').includes('"n":[3]'), true);
  assert.equal(J.changeType(d, ['o'], 'string').includes('"o":"{\\"a\\":1}"'), true);
  assert.throws(() => J.changeType(d, ['n'], 'date'), /Unknown type/);
});

test('real files: every one parses as expected, rows build, and a no-op value write gives the same bytes', () => {
  for (const f of ['ts-language-configuration.json', 'vscode-settings.json', 'git-extension-package.json', 'vscode-src-tsconfig.json', 'y_object_duplicated_key.json', 'y_string_accepted_surrogate_pair.json']) {
    const t = read(`real/${f}`);
    const d = J.parse(t);
    assert.equal(d.errors.length, 0, f);
    const rows = J.buildRows(d, { all: true }).rows;
    assert.ok(rows.length > 1, f);
    // write every scalar back with its own text: nothing may change
    let text = t;
    const scalars = rows.filter((r) => r.t !== 'object' && r.t !== 'array' && !r.more && !r.cut && !r.dup).slice(0, 300);
    for (const r of scalars) { const dd = J.parse(text); text = J.setValue(dd, JSON.parse(r.p), r.v, r.t === 'string'); }
    assert.equal(text, t, f);
  }
  const s = J.parse(read('real/vscode-settings.json'));
  assert.ok(s.hasComments);
  const dup = J.buildRows(J.parse(read('real/y_object_duplicated_key.json')), {}).rows;
  assert.deepEqual(dup.map((r) => [r.v, !!r.dup]), [[undefined, false], ['b', true], ['c', false]]);
  assert.match(J.setValue(J.parse('{"a":"b","a":"c"}'), ['a'], 'z', true), /^\{"a":"b","a":"z"\}$/);
  const surr = J.parse(read('real/y_string_accepted_surrogate_pair.json'));
  assert.equal(J.buildRows(surr, { all: true }).rows[1].v, '\u{10437}');
});

test('real file edits: renaming a key in VS Code settings.json keeps all 20 comment lines', () => {
  const t = read('real/vscode-settings.json');
  const d = J.parse(t);
  const k = J.entries(d.root)[0][0];
  const out = J.renameKey(d, [k], `${k}.renamed`);
  const comments = (x) => x.split('\n').filter((l) => /^\s*\/\//.test(l)).length;
  assert.equal(comments(out), comments(t));
  onlySpan(t, out, k.length + 3);
});

test('jsonpath: dot, bracket, wildcard, deep scan, index, slice, union, filters and jq style', () => {
  const d = J.parse(sample());
  const q = (e) => P.query(d, e).map((m) => P.format(m.path));
  assert.equal(q('$..price').length, 9);
  assert.deepEqual(q('$.products[0].sku'), ['$.products[0].sku']);
  assert.deepEqual(q("$['contact']['address'].city"), ['$.contact.address.city']);
  assert.deepEqual(q('$.products[-1].sku'), ['$.products[5].sku']);
  assert.deepEqual(q('$.products[1:3].sku'), ['$.products[1].sku', '$.products[2].sku']);
  assert.deepEqual(q('$.products[0,2].stock'), ['$.products[0].stock', '$.products[2].stock']);
  assert.deepEqual(q('$.products[?(@.active == false)].sku'), ['$.products[2].sku']);
  assert.deepEqual(q('$.products[?(@.price < 10 && @.stock > 0)].sku'), ['$.products[4].sku']);
  assert.deepEqual(q("$.shipping.zones[?(@.zone == 'EU')].days"), ['$.shipping.zones[1].days']);
  assert.equal(q('.products[].name').length, 6);
  assert.equal(q('$.features.*').length, 3);
  assert.throws(() => P.query(d, '$.products[?(@.price <)]'), /Cannot read the filter/);
  assert.throws(() => P.query(d, '$.a['), /closing \]/);
  assert.equal(P.format(['a b', 0, 'c']), '$["a b"][0].c');
});

test('bulk: set, rename, delete, upper, to number; one new text; skipped ones counted', () => {
  const d = J.parse(sample());
  let p = B.plan(d, '$.products[*].active', 'set', 'false');
  assert.equal(p.changes.length, 5);
  assert.equal(p.skipped, 1);
  let out = B.applyPlan(d, p.changes);
  assert.equal(P.query(J.parse(out), '$.products[?(@.active == true)]').length, 0);
  assert.ok(out.includes('// Demo shop catalog'));
  p = B.plan(d, '$..price', 'rename', 'cost');
  out = B.applyPlan(d, p.changes);
  assert.equal(P.query(J.parse(out), '$..cost').length, 9);
  assert.equal(P.query(J.parse(out), '$..price').length, 0);
  p = B.plan(d, '$.products[*].tags', 'delete');
  out = B.applyPlan(d, p.changes);
  assert.equal(P.query(J.parse(out), '$..tags').length, 0);
  assert.equal(J.parse(out).errors.length, 0);
  p = B.plan(d, '$.products[*].sku', 'lower');
  assert.equal(p.changes[0].after, '"gt-100"');
  p = B.plan(J.parse('{"a":["1","x","2.5"]}'), '$.a[*]', 'toNumber');
  assert.equal(B.applyPlan(J.parse('{"a":["1","x","2.5"]}'), p.changes), '{"a":[1,"x",2.5]}');
  assert.equal(B.plan(d, '$.nothing', 'delete').changes.length, 0);
  assert.equal(B.valueLiteral('"12"'), '"12"');
  assert.equal(B.valueLiteral('12'), '12');
  assert.equal(B.valueLiteral('hello'), '"hello"');
});

test('compare: key order ignored, 64-bit ids exact, arrays by position; merge copies picked changes', () => {
  const a = J.parse(read('orders-a.json')), b = J.parse(read('orders-b.json'));
  const diffs = D.compare(a, b);
  const w = diffs.map((x) => `${x.kind} ${x.where}`);
  assert.deepEqual(w.sort(), ['added $.items[2]', 'added $.paid', 'changed $.customer.city', 'changed $.items[0].qty', 'changed $.version', 'removed $.note'].sort());
  const merged = D.merge(a, diffs);
  assert.equal(D.compare(J.parse(merged), b).length, 0);
  assert.ok(merged.includes('"orderId": 18446744073709551615'));
  const one = D.merge(a, diffs.filter((x) => x.where === '$.customer.city'));
  assert.ok(one.includes('"city": "Paris"'));
  onlySpan(read('orders-a.json'), one, 8);
  const big1 = J.parse('{"id": 9007199254740993}'), big2 = J.parse('{"id": 9007199254740992}');
  assert.equal(D.compare(big1, big2).length, 1);
  assert.equal(D.compare(J.parse('{"x": 1.0}'), J.parse('{"x": 1}')).length, 0);
  const rep = D.report(diffs, 'a.json', 'b.json');
  assert.match(rep, /6 differences/);
  assert.match(rep, /\| \$\.customer\.city \| `"London"` \| `"Paris"` \|/);
  assert.throws(() => D.compare(J.parse(read('broken.json')), b), /syntax error/);
});

test('table: arrays of objects found, model, cell edit, new column for every row, CSV export', () => {
  const d = J.parse(sample());
  const arrs = T.findArrays(d);
  assert.deepEqual(arrs.map((a) => a.where), ['$.products', '$.shipping.zones']);
  const m = T.model(d, ['products']);
  assert.deepEqual(m.columns, ['sku', 'name', 'price', 'stock', 'tags', 'active']);
  assert.equal(m.rows.length, 6);
  assert.deepEqual(m.rows[0].cells.tags, { t: 'array', v: '[2]' });
  const c = T.setCell(d, ['products'], 3, 'price', '41.5', false);
  assert.ok(c.includes('"name": "Hose, 25 m", "price": 41.5,'));
  onlySpan(d.text, c, 2);
  const c2 = T.setCell(d, ['products'], 0, 'color', 'green', false);
  assert.ok(c2.includes('"active": true, "color": "green" }'));
  const col = T.addColumn(d, ['products'], 'discount');
  assert.equal(col.added, 6);
  assert.equal(P.query(J.parse(col.text), '$.products[*].discount').length, 6);
  assert.ok(J.parse(col.text).errors.length === 0);
  const csv = T.toCsv(d, ['products']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'sku,name,price,stock,tags,active');
  assert.equal(lines[2], 'WC-220,"Watering can, 10 l",18.9,35,"[""watering""]",true');
  assert.equal(lines.length, 8);
  assert.equal(T.toCsv(d, ['products'], [5, 0]).split('\r\n')[1].startsWith('PT-550'), true);
  const git = J.parse(read('real/git-extension-package.json'));
  const cmds = T.model(git, ['contributes', 'commands']);
  assert.ok(cmds.rows.length > 100);
  assert.ok(cmds.columns.includes('command') && cmds.columns.includes('title'));
});

test('minimalEdit: equal texts give null, CRLF pairs are not split', () => {
  assert.equal(J.minimalEdit('a', 'a'), null);
  assert.deepEqual(J.minimalEdit('ab\r\ncd', 'ab\r\nxd'), { start: 4, end: 5, text: 'x' });
  const e = J.minimalEdit('a\r\nb', 'a\nb');
  assert.ok(e.start <= 1);
});
