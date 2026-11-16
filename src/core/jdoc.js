'use strict';
// The JSON document model of the editor, free of the vscode module so it can be tested on its own.
// Parsing uses jsonc-parser (MIT, Microsoft, vendored in lib/jsonc-parser), which keeps the offset and length of every
// node, so the tree shows numbers exactly as written (64-bit ids stay exact) and every edit changes only the text of
// the edited node. Comments and trailing commas are allowed in every file (VS Code's own settings.json and
// keybindings.json have comments).
// Every edit function returns the whole new text; the editor turns it into one minimal replace (minimalEdit), so
// undo, redo and the dirty state stay VS Code's own.
const jp = require('../../lib/jsonc-parser/main.js');

const PARSE_OPTS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true };
const PAGE = 200; // children shown per container before "Show more"
const MAX_ROWS = 20000; // rows sent to the webview at most
const MAX_MATCHES = 1000;
const MAX_PREVIEW = 4000; // string characters shown in a row

const ERROR_TEXT = {
  InvalidSymbol: 'unexpected character',
  InvalidNumberFormat: 'this number is not written the JSON way',
  PropertyNameExpected: 'a key in double quotes was expected',
  ValueExpected: 'a value was expected',
  ColonExpected: 'a colon was expected',
  CommaExpected: 'a comma was expected',
  CloseBraceExpected: 'a closing } was expected',
  CloseBracketExpected: 'a closing ] was expected',
  EndOfFileExpected: 'the file should end here',
  InvalidCommentToken: 'this comment is not closed',
  UnexpectedEndOfComment: 'the file ends inside a comment',
  UnexpectedEndOfString: 'this string does not end with a double quote',
  UnexpectedEndOfNumber: 'the file ends inside a number',
  InvalidUnicode: 'invalid \\u escape',
  InvalidEscapeCharacter: 'invalid escape character after a backslash',
  InvalidCharacter: 'a control character inside a string',
};

function lineStarts(text) {
  const a = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) a.push(i + 1);
  return a;
}

class JDoc {
  constructor(text) {
    this.text = text;
    const errs = [];
    this.root = jp.parseTree(text, errs, PARSE_OPTS);
    this._lines = null;
    this.errors = errs.map((e) => {
      const name = jp.printParseErrorCode(e.error);
      const lc = this.lineCol(e.offset);
      return { offset: e.offset, length: e.length, line: lc.line, col: lc.col, code: name, message: `Line ${lc.line}, column ${lc.col}: ${ERROR_TEXT[name] || name}` };
    });
    this.empty = !text.trim() || !this.root;
    this.hasComments = /\/[/*]/.test(text) && hasComment(text);
  }
  get lines() { if (!this._lines) this._lines = lineStarts(this.text); return this._lines; }
  /** 1-based line and column of an offset. */
  lineCol(offset) {
    const L = this.lines;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (L[mid] <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: offset - L[lo] + 1 };
  }
  raw(node) { return this.text.substr(node.offset, node.length); }
  /** The value node at a path (array of keys and indices), or undefined. */
  at(path) {
    // like JSON.parse, the last of two equal keys wins
    let n = this.root;
    for (const k of path) {
      if (!n) return undefined;
      if (n.type === 'object') {
        let f;
        for (const p of n.children || []) if (p.children && p.children[1] && p.children[0].value === k) f = p.children[1];
        n = f;
      } else if (n.type === 'array' && typeof k === 'number') n = (n.children || [])[k];
      else return undefined;
    }
    return n;
  }
  /** The text style of the file for new text: indent and line ending. */
  get format() {
    if (!this._fmt) this._fmt = detectFormat(this.text);
    return this._fmt;
  }
}

function hasComment(text) {
  let found = false;
  jp.visit(text, { onComment: () => { found = true; } }, PARSE_OPTS);
  return found;
}

function detectFormat(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(text);
  let insertSpaces = true, tabSize = 2;
  if (m) {
    if (m[1][0] === '\t') { insertSpaces = false; tabSize = 1; } else tabSize = Math.min(8, m[1].length) || 2;
  }
  return { eol, insertSpaces, tabSize };
}

function typeOf(node) { return node ? node.type : 'null'; }
function childCount(node) { return node && (node.type === 'object' || node.type === 'array') ? (node.children || []).length : 0; }
/** [key or index, value node] pairs of a container. */
function entries(node) {
  if (!node || !node.children) return [];
  if (node.type === 'object') return node.children.filter((p) => p.children && p.children[0]).map((p) => [p.children[0].value, p.children[1], p]);
  if (node.type === 'array') return node.children.map((c, i) => [i, c, null]);
  return [];
}
const pkey = (path) => JSON.stringify(path);

/** The text of a scalar as the row shows it: strings decoded, numbers and literals exactly as written. */
function display(doc, node) {
  if (!node) return '';
  if (node.type === 'string') return String(node.value);
  if (node.type === 'number' || node.type === 'boolean' || node.type === 'null') return doc.raw(node);
  return '';
}

/** Indexes of object entries whose key comes again later (JSON readers keep the last one). */
function dupIndexes(node, kids) {
  const out = new Set();
  if (node.type !== 'object') return out;
  const last = new Map();
  kids.forEach(([k], i) => last.set(k, i));
  kids.forEach(([k], i) => { if (last.get(k) !== i) out.add(i); });
  return out;
}

function rowOf(doc, node, path, depth, key, open) {
  const t = typeOf(node);
  const r = { p: pkey(path), d: depth, k: key, t, line: node ? doc.lineCol(node.offset).line : 1 };
  if (t === 'object' || t === 'array') { r.n = childCount(node); r.open = !!open; } else {
    let v = display(doc, node);
    if (v.length > MAX_PREVIEW) { r.cut = v.length; v = v.slice(0, MAX_PREVIEW); }
    r.v = v;
  }
  return r;
}

/**
 * Rows for the webview: depth first, children of expanded containers only, PAGE children per container unless
 * limits[pathKey] says more. opts: { expanded: Set|array of path keys, limits: { [pathKey]: n }, all: expand every
 * container (until MAX_ROWS) }. Returns { rows, truncated, expanded (the set used) }.
 */
function buildRows(doc, opts = {}) {
  const expanded = new Set(opts.expanded || []);
  const limits = opts.limits || {};
  const rows = [];
  let truncated = false;
  if (!doc.root) return { rows, truncated, expanded: [...expanded] };
  const visit = (node, path, depth, key) => {
    if (rows.length >= MAX_ROWS) { truncated = true; return; }
    const k = pkey(path);
    const container = node.type === 'object' || node.type === 'array';
    const open = container && (depth === 0 && !opts.collapsedRoot ? true : opts.all || expanded.has(k));
    if (open && opts.all) expanded.add(k);
    rows.push(rowOf(doc, node, path, depth, key, open));
    if (!open) return;
    const kids = entries(node);
    const dups = dupIndexes(node, kids);
    const lim = Math.max(PAGE, Number(limits[k]) || 0);
    for (let i = 0; i < kids.length && i < lim; i++) {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      if (dups.has(i)) { rows.push({ ...rowOf(doc, kids[i][1], [...path, kids[i][0]], depth + 1, kids[i][0], false), dup: 1 }); continue; }
      visit(kids[i][1], [...path, kids[i][0]], depth + 1, kids[i][0]);
    }
    if (kids.length > lim) rows.push({ p: k, d: depth + 1, more: kids.length - lim, shown: lim });
  };
  visit(doc.root, [], 0, null);
  return { rows, truncated, expanded: [...expanded] };
}

/** Rows for a search: every key or scalar value that contains q (case-insensitive), with its parents. */
function searchRows(doc, q) {
  const needle = String(q || '').toLowerCase();
  const rows = [];
  let matches = 0, truncated = false;
  if (!doc.root || !needle) return { rows, matches, truncated };
  const hit = (s) => String(s).toLowerCase().includes(needle);
  // returns the rows of this subtree when it holds a match, else null
  const visit = (node, path, depth, key) => {
    if (matches >= MAX_MATCHES) { truncated = true; return null; }
    const container = node.type === 'object' || node.type === 'array';
    const selfHit = (typeof key === 'string' && hit(key)) || (!container && hit(display(doc, node)));
    let kidRows = [];
    if (container) {
      const kids = entries(node);
      const dups = dupIndexes(node, kids);
      for (const [i, [k, v]] of kids.entries()) {
        if (dups.has(i)) continue;
        const r = visit(v, [...path, k], depth + 1, k);
        if (r) kidRows = kidRows.concat(r);
        if (matches >= MAX_MATCHES) { truncated = true; break; }
      }
    }
    if (selfHit) matches++;
    if (!selfHit && !kidRows.length) return null;
    const row = rowOf(doc, node, path, depth, key, kidRows.length > 0);
    if (selfHit) row.m = 1;
    return [row, ...kidRows];
  };
  const r = visit(doc.root, [], 0, null);
  if (r) rows.push(...r);
  return { rows, matches, truncated };
}

// ---------- edits ----------

function replaceNode(doc, node, literal) { return doc.text.slice(0, node.offset) + literal + doc.text.slice(node.offset + node.length); }
function need(doc, path) {
  if (doc.errors.length) throw new Error('The file has a syntax error. Fix it in the text editor first.');
  const n = doc.at(path);
  if (!n) throw new Error('That value is no longer in the file.');
  return n;
}
// Text helpers for inserts and removals that keep the style of the file: no reformatting of anything but the new
// entry, comments stay where they are.
const lineStart = (text, off) => text.lastIndexOf('\n', off - 1) + 1;
const indentAt = (text, off) => /^[ \t]*/.exec(text.slice(lineStart(text, off), off + 1))[0];
const startsLine = (text, off) => /^[ \t]*$/.test(text.slice(lineStart(text, off), off));
const unitOf = (doc) => (doc.format.insertSpaces ? ' '.repeat(doc.format.tabSize) : '\t');
/** The offset just after the comma that follows a node (skipping blanks and comments), or -1. */
function commaAfter(text, end) {
  const sc = jp.createScanner(text, false);
  sc.setPosition(end);
  for (;;) {
    const k = sc.scan();
    if (k === jp.SyntaxKind.Trivia || k === jp.SyntaxKind.LineBreakTrivia || k === jp.SyntaxKind.LineCommentTrivia || k === jp.SyntaxKind.BlockCommentTrivia) continue;
    return k === jp.SyntaxKind.CommaToken ? sc.getTokenOffset() + 1 : -1;
  }
}
const endOf = (n) => n.offset + n.length;
/** Moves the lines of a multi-line value from one indent to another. */
function reindent(raw, from, to) {
  if (from === to || !raw.includes('\n')) return raw;
  return raw.split('\n').map((l, i) => (i && l.startsWith(from) ? to + l.slice(from.length) : l)).join('\n');
}
/** The child entries of a container node: properties for objects, values for arrays. */
const kidsOf = (n) => (n && n.children) || [];
/** Removes the entry at path (its key too), with its comma; the rest of the text stays. */
function removeText(doc, path) {
  const n = doc.at(path);
  const parent = doc.at(path.slice(0, -1));
  const e = parent.type === 'object' ? n.parent : n;
  const kids = kidsOf(parent);
  const i = kids.indexOf(e);
  const t = doc.text;
  if (kids.length === 1) {
    const inner = t.slice(parent.offset + 1, endOf(parent) - 1);
    const rest = inner.slice(0, e.offset - parent.offset - 1) + inner.slice(endOf(e) - parent.offset - 1).replace(/^\s*,/, '');
    if (!rest.trim()) return t.slice(0, parent.offset) + (parent.type === 'object' ? '{}' : '[]') + t.slice(endOf(parent));
  }
  if (i < kids.length - 1) {
    let s = e.offset, end = commaAfter(t, endOf(e));
    if (end < 0) end = endOf(e);
    const ls = lineStart(t, s);
    let m = /^[ \t]*/.exec(t.slice(end))[0].length;
    if (startsLine(t, s) && /^\r?\n/.test(t.slice(end + m))) { s = ls; end += m + (t[end + m] === '\r' ? 2 : 1); } else end += m;
    return t.slice(0, s) + t.slice(end);
  }
  const prev = kids[i - 1];
  return t.slice(0, endOf(prev)) + t.slice(endOf(e));
}
/** Inserts an entry (key used for objects) at index i of the container at ppath. srcIndent: the indent the literal's
 *  own lines were written with (for values copied from elsewhere). */
function insertText(doc, ppath, i, key, literal, srcIndent) {
  const parent = doc.at(ppath);
  if (!parent || (parent.type !== 'object' && parent.type !== 'array')) throw new Error('Only an object or an array can get a new entry.');
  const t = doc.text;
  const kids = kidsOf(parent);
  const head = (lit) => (parent.type === 'object' ? `${JSON.stringify(String(key))}: ${lit}` : lit);
  const eol = doc.format.eol;
  if (!kids.length) {
    const base = indentAt(t, parent.offset);
    const ind = base + unitOf(doc);
    const entry = head(srcIndent !== undefined ? reindent(literal, srcIndent, ind) : literal);
    const open = parent.type === 'object' ? '{' : '[', close = parent.type === 'object' ? '}' : ']';
    return t.slice(0, parent.offset) + open + eol + ind + entry + eol + base + close + t.slice(endOf(parent));
  }
  const multi = kids.some((k) => !startsLine(t, k.offset)) ? false : true;
  const k0 = kids[Math.min(i, kids.length - 1)];
  const ind = multi ? indentAt(t, k0.offset) : indentAt(t, k0.offset) + unitOf(doc);
  const entry = head(srcIndent !== undefined ? reindent(literal, srcIndent, ind) : literal);
  if (i < kids.length) {
    const at = kids[i].offset;
    return t.slice(0, at) + entry + ',' + (multi ? eol + indentAt(t, at) : ' ') + t.slice(at);
  }
  const last = kids[kids.length - 1];
  const c = commaAfter(t, endOf(last));
  const sep = multi ? eol + indentAt(t, last.offset) : ' ';
  if (c >= 0) return t.slice(0, c) + sep + entry + ',' + t.slice(c);
  return t.slice(0, endOf(last)) + ',' + sep + entry + t.slice(endOf(last));
}
/** Sets any value from JSON text (used by the form and the tools); a missing key or index is added. */
function setRaw(doc, path, literal, srcIndent) {
  const n = doc.at(path);
  if (n) return replaceNode(doc, n, srcIndent !== undefined ? reindent(literal, srcIndent, indentAt(doc.text, n.parent && n.parent.type === 'property' ? n.parent.offset : n.offset)) : literal);
  const parent = doc.at(path.slice(0, -1));
  if (!parent) throw new Error('The parent of that value is not in the file.');
  const last = path[path.length - 1];
  return insertText(doc, path.slice(0, -1), parent.type === 'array' ? Math.min(Number(last), childCount(parent)) : childCount(parent), last, literal, srcIndent);
}
const NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
/** The JSON text for what the user typed: a JSON number, true, false or null as written; anything else a string. */
function literalOf(input, asString) {
  const s = String(input);
  if (asString) return JSON.stringify(s);
  const t = s.trim();
  if (NUM_RE.test(t) || t === 'true' || t === 'false' || t === 'null') return t;
  return JSON.stringify(s);
}
/** Sets a scalar value. asString: the value was a string (stays a string). */
function setValue(doc, path, input, asString) {
  const n = need(doc, path);
  if (n.type === 'object' || n.type === 'array') throw new Error('Only a text, number, true/false or null value can be edited in place. Use the type menu to change an object or array.');
  // the same value written another way (escapes, spacing) keeps its text
  if (n.type === 'string' && asString && n.value === String(input)) return doc.text;
  const lit = literalOf(input, asString);
  if (n.type !== 'string' && lit === doc.raw(n)) return doc.text;
  return replaceNode(doc, n, lit);
}
function parentOf(doc, path) { return doc.at(path.slice(0, -1)); }
function renameKey(doc, path, newKey) {
  const n = need(doc, path);
  const prop = n.parent;
  if (!prop || prop.type !== 'property') throw new Error('Only keys of an object can be renamed.');
  const key = String(newKey);
  if (key === prop.children[0].value) return doc.text;
  if (entries(prop.parent).some(([k]) => k === key)) throw new Error(`The key "${key}" is already used in this object.`);
  return replaceNode(doc, prop.children[0], JSON.stringify(key));
}
function remove(doc, path) {
  need(doc, path);
  if (!path.length) throw new Error('The top value cannot be deleted. Change its type instead.');
  return removeText(doc, path);
}
function uniqueKey(container, base) {
  const used = new Set(entries(container).map(([k]) => k));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}
/** Adds a new child at the end of an object or array. Returns { text, path } of the new value. */
function addChild(doc, path, literal = '""', key) {
  if (doc.empty && !path.length && !doc.errors.length) return { text: literal === '""' ? '{}' : literal, path: [] };
  const n = need(doc, path);
  if (n.type === 'object') {
    const k = key !== undefined ? String(key) : uniqueKey(n, 'newKey');
    if (entries(n).some(([x]) => x === k)) throw new Error(`The key "${k}" is already used in this object.`);
    return { text: insertText(doc, path, childCount(n), k, literal), path: [...path, k] };
  }
  if (n.type === 'array') {
    const i = childCount(n);
    return { text: insertText(doc, path, i, null, literal), path: [...path, i] };
  }
  throw new Error('Only an object or an array can get a new entry.');
}
/** Copies a value next to itself: arrays get it after the original, objects under "<key> copy". */
function duplicate(doc, path) {
  const n = need(doc, path);
  if (!path.length) throw new Error('The top value cannot be duplicated.');
  const parent = parentOf(doc, path);
  const ppath = path.slice(0, -1);
  const raw = doc.raw(n);
  const last = path[path.length - 1];
  const idx = entries(parent).findIndex(([x]) => x === last);
  if (parent.type === 'array') return { text: insertText(doc, ppath, idx + 1, null, raw), path: [...ppath, idx + 1] };
  const k = uniqueKey(parent, `${last} copy`);
  return { text: insertText(doc, ppath, idx + 1, k, raw), path: [...ppath, k] };
}
/** Moves a value to another position (0-based index it gets among its siblings) in the same parent. */
function move(doc, path, to) {
  const n = need(doc, path);
  if (!path.length) throw new Error('The top value cannot be moved.');
  const parent = parentOf(doc, path);
  const kids = entries(parent);
  const last = path[path.length - 1];
  const from = kids.findIndex(([k]) => k === last);
  const target = Math.max(0, Math.min(kids.length - 1, Number(to) | 0));
  if (from < 0 || target === from) return { text: doc.text, path };
  const raw = doc.raw(n);
  const ppath = path.slice(0, -1);
  const removed = new JDoc(removeText(doc, path));
  const text = insertText(removed, ppath, target, parent.type === 'object' ? last : null, raw);
  return { text, path: parent.type === 'array' ? [...ppath, target] : path };
}
const TYPES = ['string', 'number', 'boolean', 'null', 'object', 'array'];
/** Changes the type of a value, keeping what can be kept ("12" -> 12, 1 -> "1", "true" -> true, ...). */
function changeType(doc, path, to) {
  const n = need(doc, path);
  if (!TYPES.includes(to)) throw new Error(`Unknown type: ${to}`);
  if (n.type === to) return doc.text;
  const shown = display(doc, n);
  let lit;
  const parsedAs = (type) => { try { const v = JSON.parse(shown); return (type === 'array' ? Array.isArray(v) : v && typeof v === 'object' && !Array.isArray(v)) ? shown.trim() : null; } catch (e) { return null; } };
  switch (to) {
    case 'string':
      lit = (n.type === 'object' || n.type === 'array') ? JSON.stringify(JSON.stringify(jp.getNodeValue(n))) : JSON.stringify(shown);
      break;
    case 'number':
      if (n.type === 'string' && NUM_RE.test(shown.trim())) lit = shown.trim();
      else if (n.type === 'boolean') lit = shown === 'true' ? '1' : '0';
      else lit = '0';
      break;
    case 'boolean':
      if (n.type === 'string') lit = /^(true|yes|1|on)$/i.test(shown.trim()) ? 'true' : 'false';
      else if (n.type === 'number') lit = Number(shown) !== 0 ? 'true' : 'false';
      else lit = 'false';
      break;
    case 'null': lit = 'null'; break;
    case 'object': lit = (n.type === 'string' && parsedAs('object')) || '{}'; break;
    case 'array':
      if (n.type === 'string' && parsedAs('array')) lit = parsedAs('array');
      else if (n.type === 'object') lit = '[]';
      else lit = `[${doc.raw(n)}]`;
      break;
    default: lit = 'null';
  }
  return replaceNode(doc, n, lit);
}

/** One replace that turns a into b: { start, end (in a), text }; null when equal. */
function minimalEdit(a, b) {
  if (a === b) return null;
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
  // do not split a \r\n pair
  if (s > 0 && a[s - 1] === '\r' && (a[s] === '\n' || b[s] === '\n')) s--;
  return { start: s, end: ea, text: b.slice(s, eb) };
}

/** A short summary for the status line. */
function stats(doc) {
  let objects = 0, arrays = 0, values = 0;
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'object') { objects++; for (const [, v] of entries(n)) walk(v); } else if (n.type === 'array') { arrays++; for (const c of n.children || []) walk(c); } else values++;
  };
  walk(doc.root);
  return { objects, arrays, values };
}

module.exports = {
  JDoc, parse: (t) => new JDoc(t), buildRows, searchRows, entries, display, typeOf, childCount, pkey, literalOf, NUM_RE,
  setValue, setRaw, renameKey, remove, addChild, duplicate, move, changeType, insertText, removeText, reindent, indentAt, minimalEdit, stats,
  detectFormat, TYPES, PAGE, MAX_ROWS, MAX_PREVIEW, jp,
};
