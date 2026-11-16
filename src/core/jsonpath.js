'use strict';
// A JSONPath reader for the Bulk edit tool, run on the jsonc-parser tree so every match keeps its offset in the text.
// Supported: $ (root), .key, ['key'] / ["key"], [0] and [-1], [*] and .*, ..key / ..* (any depth), [0,2] and
// ['a','b'] unions, [1:5] / [::2] slices, and filters [?(@.price < 10)], [?(@.tags)], [?(@.name == 'x')] with
// == != < <= > >= and && / ||. jq style also works for the simple cases: .a.b[] and .items[].id (a leading dot
// means $, [] means [*]).
const { entries, display } = require('./jdoc');

function tokenize(src) {
  let s = String(src || '').trim();
  if (!s) throw new Error('Type a path such as $..price or $.items[*].name');
  if (s[0] === '.' || s[0] === '[') s = '$' + (s[0] === '.' && s[1] !== '.' && s.length === 1 ? '' : s);
  if (s[0] !== '$') s = '$.' + s;
  const out = [];
  let i = 1;
  const ident = () => { const m = /^[A-Za-z_$ -￿][\w$ -￿-]*/.exec(s.slice(i)); if (!m) return null; i += m[0].length; return m[0]; };
  while (i < s.length) {
    if (s.startsWith('..', i)) {
      i += 2;
      if (s[i] === '*') { i++; out.push({ deep: true, any: true }); continue; }
      if (s[i] === '[') { out.push({ deep: true, any: true, scan: true }); continue; }
      const id = ident();
      if (id === null) throw new Error(`A key name was expected after ".." at character ${i + 1}`);
      out.push({ deep: true, keys: [id] });
      continue;
    }
    if (s[i] === '.') {
      i++;
      if (s[i] === '*') { i++; out.push({ any: true }); continue; }
      if (s[i] === '[') continue;
      const id = ident();
      if (id === null) throw new Error(`A key name was expected after "." at character ${i + 1}`);
      out.push({ keys: [id] });
      continue;
    }
    if (s[i] === '[') {
      const end = findClose(s, i);
      const body = s.slice(i + 1, end).trim();
      i = end + 1;
      if (body === '' || body === '*') { out.push({ any: true }); continue; }
      if (body[0] === '?') { out.push({ filter: parseFilter(body.slice(1).trim()) }); continue; }
      if (/^-?\d*\s*:\s*-?\d*(\s*:\s*-?\d*)?$/.test(body)) {
        const [a, b, c] = body.split(':').map((x) => x.trim());
        out.push({ slice: [a === '' ? null : Number(a), b === '' || b === undefined ? null : Number(b), c === '' || c === undefined ? 1 : Number(c)] });
        continue;
      }
      const parts = splitTop(body, ',').map((x) => x.trim());
      const keys = parts.map((p) => {
        if (/^-?\d+$/.test(p)) return Number(p);
        if (/^'(?:[^'\\]|\\.)*'$/.test(p)) return p.slice(1, -1).replace(/\\(.)/g, '$1');
        if (/^"(?:[^"\\]|\\.)*"$/.test(p)) return JSON.parse(p);
        throw new Error(`Cannot read [${body}]: use a number, a quoted key, * or a filter`);
      });
      out.push({ keys });
      continue;
    }
    throw new Error(`Unexpected "${s[i]}" at character ${i + 1}`);
  }
  return out;
}
function findClose(s, i) {
  let depth = 0, q = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
    if (c === '\'' || c === '"') q = c;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (!depth) return j; }
  }
  throw new Error('A closing ] is missing');
}
function splitTop(s, sep) {
  const out = [];
  let q = null, depth = 0, cur = '';
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { cur += c; if (c === '\\') { cur += s[++j] || ''; } else if (c === q) q = null; continue; }
    if (c === '\'' || c === '"') { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (!depth && s.startsWith(sep, j)) { out.push(cur); cur = ''; j += sep.length - 1; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// filter: (@.a.b op literal) joined by && / ||
function parseFilter(src) {
  let s = src.trim();
  if (s[0] === '(' && s[s.length - 1] === ')') s = s.slice(1, -1).trim();
  const ors = splitTop(s, '||');
  return ors.map((o) => splitTop(o, '&&').map((c) => parseCond(c.trim())));
}
function parseCond(c) {
  let s = c;
  if (s[0] === '(' && s[s.length - 1] === ')') s = s.slice(1, -1).trim();
  const m = /^(@(?:\.[\w$-]+|\[(?:'[^']*'|"[^"]*"|\d+)\])*)\s*(==|!=|<=|>=|<|>)?\s*(.*)$/.exec(s);
  if (!m || (m[2] && !m[3])) throw new Error(`Cannot read the filter "${c}". Example: [?(@.price < 10)]`);
  const path = [];
  const re = /\.([\w$-]+)|\['([^']*)'\]|\["([^"]*)"\]|\[(\d+)\]/g;
  let x;
  while ((x = re.exec(m[1].slice(1)))) path.push(x[1] ?? x[2] ?? x[3] ?? Number(x[4]));
  let lit;
  if (m[2]) {
    const v = m[3].trim();
    if (/^'.*'$/.test(v)) lit = v.slice(1, -1);
    else { try { lit = JSON.parse(v); } catch (e) { throw new Error(`Cannot read the value ${v} in the filter. Put text in quotes.`); } }
  }
  return { path, op: m[2] || 'exists', lit };
}

function child(node, key) {
  for (const [k, v] of entries(node)) if (k === key) return v;
  return undefined;
}
function scalarOf(doc, n) {
  if (!n) return undefined;
  if (n.type === 'number') return Number(doc.raw(n));
  if (n.type === 'string') return n.value;
  if (n.type === 'boolean') return n.value;
  if (n.type === 'null') return null;
  return n.type;
}
function test(doc, node, filter) {
  return filter.some((and) => and.every((c) => {
    let n = node;
    for (const k of c.path) { n = n && child(n, k); if (!n) break; }
    if (c.op === 'exists') return !!n && !(n.type === 'boolean' && n.value === false) && n.type !== 'null';
    if (!n) return c.op === '!=';
    const v = scalarOf(doc, n);
    switch (c.op) {
      case '==': return v === c.lit;
      case '!=': return v !== c.lit;
      case '<': return v < c.lit;
      case '<=': return v <= c.lit;
      case '>': return v > c.lit;
      case '>=': return v >= c.lit;
      default: return false;
    }
  }));
}

/** All matches of a JSONPath in a JDoc: [{ path, node }], in document order, without duplicates. */
function query(doc, src, limit = 100000) {
  const toks = tokenize(src);
  if (!doc.root) return [];
  let cur = [{ path: [], node: doc.root }];
  const desc = (m, out) => {
    out.push(m);
    for (const [k, v] of entries(m.node)) desc({ path: [...m.path, k], node: v }, out);
  };
  for (const t of toks) {
    let base = cur;
    if (t.deep) { const all = []; for (const m of cur) desc(m, all); base = all; }
    const next = [];
    for (const m of base) {
      const kids = entries(m.node);
      if (t.scan) { next.push(m); continue; }
      if (t.any) { for (const [k, v] of kids) next.push({ path: [...m.path, k], node: v }); continue; }
      if (t.keys) {
        for (let key of t.keys) {
          if (typeof key === 'number' && m.node.type === 'array') { if (key < 0) key += kids.length; if (kids[key]) next.push({ path: [...m.path, key], node: kids[key][1] }); } else if (m.node.type === 'object') {
            const v = child(m.node, String(key));
            if (v) next.push({ path: [...m.path, String(key)], node: v });
          }
        }
        continue;
      }
      if (t.slice) {
        if (m.node.type !== 'array') continue;
        const n = kids.length;
        let [a, b, step] = t.slice;
        step = step || 1;
        a = a === null ? (step > 0 ? 0 : n - 1) : a < 0 ? a + n : a;
        b = b === null ? (step > 0 ? n : -1) : b < 0 ? b + n : b;
        for (let i = a; step > 0 ? i < b : i > b; i += step) if (kids[i]) next.push({ path: [...m.path, i], node: kids[i][1] });
        continue;
      }
      if (t.filter) { for (const [k, v] of kids) if (test(doc, v, t.filter)) next.push({ path: [...m.path, k], node: v }); }
    }
    cur = next;
    if (cur.length > limit) throw new Error(`More than ${limit} matches. Narrow the path.`);
  }
  const seen = new Set();
  return cur.filter((m) => { const k = JSON.stringify(m.path); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.node.offset - b.node.offset);
}

/** "$.a[0]['b c']" for a path array. */
function format(path) {
  return '$' + path.map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('');
}

module.exports = { query, tokenize, format, scalarOf, display };
