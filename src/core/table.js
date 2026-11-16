'use strict';
// Table mode (Zovo Pro): an array of objects as rows and columns. Cells edit the JSON text in place; a new column is
// added to every object row that lacks it; the table exports as CSV (RFC 4180, numbers exactly as written).
const J = require('./jdoc');
const { format } = require('./jsonpath');

const MAX_TABLE_ROWS = 5000;
const MAX_COLUMNS = 200;

/** Arrays in the document that hold objects (at least half of their items): [{ path, where, rows, columns }]. */
function findArrays(doc, limit = 50) {
  const out = [];
  const walk = (n, path) => {
    if (!n || out.length >= limit) return;
    if (n.type === 'array') {
      const kids = n.children || [];
      const objs = kids.filter((k) => k.type === 'object');
      if (objs.length && objs.length * 2 >= kids.length) {
        const cols = new Set();
        for (const o of objs.slice(0, 500)) for (const [k] of J.entries(o)) cols.add(k);
        out.push({ path, where: format(path), rows: kids.length, columns: cols.size });
      }
    }
    for (const [k, v] of J.entries(n)) walk(v, [...path, k]);
  };
  walk(doc.root, []);
  return out;
}

function cellOf(doc, v) {
  if (!v) return null;
  if (v.type === 'object') return { t: 'object', v: `{${J.childCount(v)}}` };
  if (v.type === 'array') return { t: 'array', v: `[${J.childCount(v)}]` };
  return { t: v.type, v: J.display(doc, v) };
}

/** { columns, rows: [{ i, obj, cells: { [col]: { t, v } } }], total, truncated } for the array at path. */
function model(doc, path) {
  const arr = doc.at(path);
  if (!arr || arr.type !== 'array') throw new Error('That value is not an array any more.');
  const kids = arr.children || [];
  const cols = [];
  const seen = new Set();
  for (const o of kids) if (o.type === 'object') for (const [k] of J.entries(o)) if (!seen.has(k) && cols.length < MAX_COLUMNS) { seen.add(k); cols.push(k); }
  const rows = [];
  for (let i = 0; i < kids.length && i < MAX_TABLE_ROWS; i++) {
    const o = kids[i];
    const cells = {};
    if (o.type === 'object') for (const [k, v] of J.entries(o)) if (seen.has(k)) cells[k] = cellOf(doc, v);
    rows.push({ i, obj: o.type === 'object', cells, other: o.type === 'object' ? undefined : cellOf(doc, o) });
  }
  return { columns: cols, rows, total: kids.length, truncated: kids.length > MAX_TABLE_ROWS, where: format(path) };
}

/** Sets one cell; a missing key is added to that row. asString keeps text as text. */
function setCell(doc, path, i, col, input, asString) {
  const row = doc.at([...path, i]);
  if (!row || row.type !== 'object') throw new Error(`Row ${i + 1} is not an object.`);
  const cur = doc.at([...path, i, col]);
  if (cur && (cur.type === 'object' || cur.type === 'array')) throw new Error('A nested object or array cell is edited in the tree.');
  return J.setRaw(doc, [...path, i, col], J.literalOf(input, asString));
}

/** Adds the key to every object row that does not have it (value: JSON text, default null). */
function addColumn(doc, path, name, literal = 'null') {
  const key = String(name || '').trim();
  if (!key) throw new Error('Type a column name.');
  const arr = doc.at(path);
  if (!arr || arr.type !== 'array') throw new Error('That value is not an array any more.');
  const kids = arr.children || [];
  let text = doc.text;
  let added = 0;
  // last row first: earlier rows keep their offsets
  for (let i = kids.length - 1; i >= 0; i--) {
    const o = kids[i];
    if (o.type !== 'object' || J.entries(o).some(([k]) => k === key)) continue;
    const d = new J.JDoc(text);
    text = J.insertText(d, [...path, i], J.childCount(d.at([...path, i])), key, literal);
    added++;
  }
  return { text, added };
}

function csvField(s) { const t = String(s); return /[",\r\n]/.test(t) || /^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }
/** CSV of the array: one row per item, the columns of the table; nested values as compact JSON. order: row indices. */
function toCsv(doc, path, order) {
  const arr = doc.at(path);
  const m = model(doc, path);
  const kids = arr.children || [];
  const idx = order && order.length ? order : kids.map((_, i) => i);
  const lines = [m.columns.map(csvField).join(',')];
  for (const i of idx) {
    const o = kids[i];
    if (!o) continue;
    if (o.type !== 'object') { lines.push(csvField(o.type === 'array' ? JSON.stringify(J.jp.getNodeValue(o)) : J.display(doc, o))); continue; }
    const map = new Map(J.entries(o).map(([k, v]) => [k, v]));
    lines.push(m.columns.map((c) => {
      const v = map.get(c);
      if (!v) return '';
      if (v.type === 'object' || v.type === 'array') return csvField(JSON.stringify(J.jp.getNodeValue(v)));
      if (v.type === 'null') return '';
      return csvField(J.display(doc, v));
    }).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { findArrays, model, setCell, addColumn, toCsv, csvField, MAX_TABLE_ROWS };
