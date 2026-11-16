'use strict';
// Compare and merge (Zovo Pro): the differences between two JSON documents by key path. Object keys are matched by
// name (their order does not matter), arrays by position. Numbers compare by value when both are exact in a double,
// else by their text, so 64-bit ids compare exactly. A change copied from the other file keeps its text as written there.
const J = require('./jdoc');
const { format } = require('./jsonpath');

function sameScalar(da, a, db, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'string') return a.value === b.value;
  const ra = da.raw(a), rb = db.raw(b);
  if (ra === rb) return true;
  if (a.type === 'number') {
    const x = Number(ra), y = Number(rb);
    return Number.isSafeInteger(Math.trunc(x)) && Number.isSafeInteger(Math.trunc(y)) && x === y && !/\d{16,}/.test(ra + rb);
  }
  return false;
}
const isBox = (n) => n && (n.type === 'object' || n.type === 'array');
const shortRaw = (d, n) => { const t = d.raw(n).replace(/\s+/g, ' '); return t.length > 70 ? t.slice(0, 69) + '…' : t; };
const indentOf = (d, n) => J.indentAt(d.text, n.parent && n.parent.type === 'property' ? n.parent.offset : n.offset);

/** Differences from a to b: [{ kind: 'changed'|'added'|'removed', path, where, a, b, raw, indent }]. */
function compare(da, db, limit = 5000) {
  if (da.errors.length) throw new Error(`This file has a syntax error: ${da.errors[0].message}`);
  if (db.errors.length) throw new Error(`The other file has a syntax error: ${db.errors[0].message}`);
  const out = [];
  const walk = (a, b, path) => {
    if (out.length >= limit) return;
    if (isBox(a) && isBox(b) && a.type === b.type) {
      if (a.type === 'object') {
        const ea = J.entries(a), eb = J.entries(b);
        const mb = new Map(eb.map(([k, v]) => [k, v]));
        const ma = new Map(ea.map(([k, v]) => [k, v]));
        for (const [k, v] of ea) { if (mb.has(k)) walk(v, mb.get(k), [...path, k]); else out.push({ kind: 'removed', path: [...path, k], a: shortRaw(da, v) }); }
        for (const [k, v] of eb) if (!ma.has(k)) out.push({ kind: 'added', path: [...path, k], b: shortRaw(db, v), raw: db.raw(v), indent: indentOf(db, v) });
      } else {
        const ka = a.children || [], kb = b.children || [];
        for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
          if (i >= ka.length) out.push({ kind: 'added', path: [...path, i], b: shortRaw(db, kb[i]), raw: db.raw(kb[i]), indent: indentOf(db, kb[i]) });
          else if (i >= kb.length) out.push({ kind: 'removed', path: [...path, i], a: shortRaw(da, ka[i]) });
          else walk(ka[i], kb[i], [...path, i]);
        }
      }
      return;
    }
    if (!isBox(a) && !isBox(b) && sameScalar(da, a, db, b)) return;
    out.push({ kind: 'changed', path, a: shortRaw(da, a), b: shortRaw(db, b), raw: db.raw(b), indent: indentOf(db, b) });
  };
  if (da.root && db.root) walk(da.root, db.root, []);
  for (const d of out) d.where = format(d.path);
  return out;
}

/** Copies the picked differences from b into a's text. Returns the new text. */
function merge(da, picks) {
  let d = da;
  const sets = picks.filter((p) => p.kind !== 'removed');
  // removals last, deepest and highest index first, so the other paths stay valid
  const dels = picks.filter((p) => p.kind === 'removed').sort((x, y) => {
    for (let i = 0; i < Math.min(x.path.length, y.path.length); i++) if (x.path[i] !== y.path[i]) return typeof x.path[i] === 'number' && typeof y.path[i] === 'number' ? y.path[i] - x.path[i] : 0;
    return y.path.length - x.path.length;
  });
  const addsSorted = sets.slice().sort((x, y) => {
    const a = x.path[x.path.length - 1], b = y.path[y.path.length - 1];
    return typeof a === 'number' && typeof b === 'number' ? a - b : 0;
  });
  for (const p of addsSorted) d = new J.JDoc(J.setRaw(d, p.path, p.raw, p.indent));
  for (const p of dels) { if (d.at(p.path)) d = new J.JDoc(J.remove(d, p.path)); }
  return d.text;
}

function report(diffs, nameA, nameB) {
  const lines = [`# Compare ${nameA} with ${nameB}`, '', `${diffs.length} difference${diffs.length === 1 ? '' : 's'} by key path (key order ignored, arrays by position).`, ''];
  const c = (k) => diffs.filter((d) => d.kind === k).length;
  lines.push(`- Changed: ${c('changed')}`, `- Only in ${nameB}: ${c('added')}`, `- Only in ${nameA}: ${c('removed')}`, '');
  if (diffs.length) {
    lines.push(`| Path | ${nameA} | ${nameB} |`, '|---|---|---|');
    const cell = (s) => (s === undefined ? '' : '`' + String(s).replace(/\|/g, '\\|').replace(/`/g, "'") + '`');
    for (const d of diffs) lines.push(`| ${d.where.replace(/\|/g, '\\|')} | ${d.kind === 'added' ? '(missing)' : cell(d.a)} | ${d.kind === 'removed' ? '(missing)' : cell(d.b)} |`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { compare, merge, report, sameScalar };
