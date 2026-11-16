'use strict';
// Bulk edit (Zovo Pro): the changes a JSONPath selection gets from one action, as a preview list, then one new text.
const J = require('./jdoc');
const { query, format } = require('./jsonpath');

const ACTIONS = {
  set: { label: 'Set the value', needs: 'value' },
  rename: { label: 'Rename the key', needs: 'key' },
  delete: { label: 'Delete', needs: null },
  upper: { label: 'Text to UPPER CASE', needs: null },
  lower: { label: 'Text to lower case', needs: null },
  trim: { label: 'Trim spaces around text', needs: null },
  toString: { label: 'Convert to text (string)', needs: null },
  toNumber: { label: 'Convert text to number', needs: null },
};

/** JSON text for a typed value: valid JSON stays as written ("12" in quotes is text, 12 a number), else text. */
function valueLiteral(input) {
  const s = String(input);
  try { JSON.parse(s); return s.trim(); } catch (e) { return JSON.stringify(s); }
}
const short = (s, n = 60) => { const t = String(s).replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const isAncestor = (a, b) => a.length < b.length && a.every((k, i) => k === b[i]);

/**
 * The planned changes: { changes: [{ path, where, before, after, literal?, key?, skip? }], skipped }.
 * Matches inside another match are left out (the outer one wins).
 */
function plan(doc, expr, action, arg) {
  if (!ACTIONS[action]) throw new Error(`Unknown action: ${action}`);
  if (doc.errors.length) throw new Error('The file has a syntax error. Fix it in the text editor first.');
  let ms = query(doc, expr);
  if (!ms.length) return { changes: [], skipped: 0, matches: 0 };
  const matches = ms.length;
  ms = ms.filter((m) => !ms.some((o) => o !== m && isAncestor(o.path, m.path)));
  const changes = [];
  let skipped = 0;
  for (const m of ms) {
    const n = m.node;
    const where = format(m.path);
    const before = n.type === 'object' || n.type === 'array' ? short(doc.raw(n)) : short(n.type === 'string' ? JSON.stringify(n.value) : doc.raw(n));
    let lit = null;
    switch (action) {
      case 'set': lit = valueLiteral(arg); break;
      case 'delete':
        if (!m.path.length) { skipped++; continue; }
        changes.push({ path: m.path, where, before, after: '(deleted)', del: true });
        continue;
      case 'rename': {
        const prop = n.parent;
        if (!prop || prop.type !== 'property') { skipped++; continue; }
        const key = String(arg);
        if (prop.children[0].value === key) { skipped++; continue; }
        if (J.entries(prop.parent).some(([k]) => k === key)) { skipped++; continue; }
        changes.push({ path: m.path, where, before: JSON.stringify(prop.children[0].value), after: JSON.stringify(key), keyNode: prop.children[0], literal: JSON.stringify(key) });
        continue;
      }
      case 'upper': case 'lower': case 'trim': {
        if (n.type !== 'string') { skipped++; continue; }
        const v = action === 'upper' ? n.value.toUpperCase() : action === 'lower' ? n.value.toLowerCase() : n.value.trim();
        if (v === n.value) { skipped++; continue; }
        lit = JSON.stringify(v);
        break;
      }
      case 'toString':
        if (n.type === 'string' || n.type === 'object' || n.type === 'array') { skipped++; continue; }
        lit = JSON.stringify(doc.raw(n));
        break;
      case 'toNumber':
        if (n.type !== 'string' || !J.NUM_RE.test(n.value.trim())) { skipped++; continue; }
        lit = n.value.trim();
        break;
      default: break;
    }
    if (lit === null || lit === doc.raw(n)) { skipped++; continue; }
    changes.push({ path: m.path, where, before, after: short(lit), literal: lit, node: n });
  }
  return { changes, skipped, matches };
}

/** The text after the planned changes. */
function applyPlan(doc, changes) {
  const dels = changes.filter((c) => c.del).sort((a, b) => doc.at(b.path).offset - doc.at(a.path).offset);
  const reps = changes.filter((c) => !c.del).map((c) => ({ node: c.keyNode || c.node, literal: c.literal })).sort((a, b) => b.node.offset - a.node.offset);
  let text = doc.text;
  for (const r of reps) text = text.slice(0, r.node.offset) + r.literal + text.slice(r.node.offset + r.node.length);
  let d = reps.length ? new J.JDoc(text) : doc;
  // deletions last to first, so the paths of the ones still to do stay valid
  for (const c of dels) { text = J.remove(d, c.path); d = new J.JDoc(text); }
  return text;
}

module.exports = { ACTIONS, plan, applyPlan, valueLiteral };
