'use strict';
// The tree and form editor: a custom text editor for .json, .jsonc and .json5 (priority "option": the text editor stays
// the default). The file stays a normal VS Code text document, so undo, redo, save, hot exit, the dirty dot and git
// work as for any text file. An edit in the tree or the form changes only the text of the edited value (src/core/jdoc.js)
// and goes in as one replace, so comments, key order and formatting elsewhere stay. A file that is only opened is
// never written. Typing in the text editor redraws the tree after a short pause.
const vscode = require('vscode');
const J = require('./core/jdoc');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW_TYPE = 'jsonEditor.tree';
const PREFIX = 'jsonEditor';

function webviewOptions(ctx, hooks) {
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const reach = hooks.reach;
  return { enableScripts: true, enableCommandUris: [...new Set([...support.commandUris(PREFIX), ...(reach ? reach.commandIds() : [])])], localResourceRoots: [media] };
}

/** The fields the form shows: the children of the selected object or array, or the siblings of a selected value. */
function formOf(doc, path) {
  let base = path;
  let node = doc.at(path);
  if (!node) { base = []; node = doc.root; }
  if (node && node.type !== 'object' && node.type !== 'array' && base.length) { base = base.slice(0, -1); node = doc.at(base); }
  if (!node || (node.type !== 'object' && node.type !== 'array')) return { p: J.pkey(base), t: node ? node.type : 'null', fields: [] };
  const fields = [];
  for (const [k, v] of J.entries(node).slice(0, 300)) {
    const f = { k, p: J.pkey([...base, k]), t: v.type };
    if (v.type === 'object' || v.type === 'array') f.n = J.childCount(v); else { f.v = J.display(doc, v); if (f.v.length > J.MAX_PREVIEW) { f.cut = f.v.length; f.v = f.v.slice(0, J.MAX_PREVIEW); } }
    fields.push(f);
  }
  return { p: J.pkey(base), t: node.type, fields, more: Math.max(0, J.childCount(node) - 300), sel: J.pkey(path) };
}

class JsonEditorProvider {
  constructor(ctx, hooks) {
    this.ctx = ctx;
    this.hooks = hooks; // { rating, reach, isSample(uri) }
    this.sessions = new Map();
    this.lastActive = null;
  }

  async resolveCustomTextEditor(document, panel) {
    const key = document.uri.toString();
    const fsReadOnly = (() => { try { return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false; } catch (e) { return false; } })();
    const s = {
      document, panel, gen: 0, jdoc: null, version: -1, counted: false, timer: null, lastWritten: null, queue: Promise.resolve(),
      readOnly: fsReadOnly || document.uri.scheme === 'git' || document.uri.scheme === 'gitlens',
      view: { expanded: [], limits: {}, filter: '' }, selected: [], ready: null, readyResolve: null, rendered: null, renderedResolve: null, last: null,
    };
    s.ready = new Promise((r) => { s.readyResolve = r; });
    s.rendered = new Promise((r) => { s.renderedResolve = r; });
    this.sessions.set(key, s);
    this.lastActive = s;
    const wv = panel.webview;
    wv.options = webviewOptions(this.ctx, this.hooks);
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const reach = this.hooks.reach;
    wv.html = editorHtml({
      cspSource: wv.cspSource,
      media: (name) => wv.asWebviewUri(vscode.Uri.joinPath(media, name)).toString(),
      title: 'JSON Editor', showSupportLinks: support.showLinks(vscode, PREFIX),
      head: reach ? (n) => reach.headHtml(n) : undefined,
    });
    const subs = [];
    if (reach) subs.push(reach.attach(wv, panel));
    const post = (m) => { try { const p = wv.postMessage(m); return p && p.then ? p.then(undefined, () => false) : Promise.resolve(p); } catch (e) { return Promise.resolve(false); } };
    s.post = post;
    s.render = (extra = {}) => this.render(s, extra);

    subs.push(wv.onDidReceiveMessage((m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'ready':
          if (m.state && typeof m.state === 'object') s.view = { expanded: arr(m.state.expanded), limits: obj(m.state.limits), filter: '' };
          s.render({ first: true }); s.readyResolve(); break;
        case 'view':
          s.view = { expanded: arr(m.expanded), limits: obj(m.limits), filter: typeof m.filter === 'string' ? m.filter : '', all: !!m.all };
          s.render({ keepScroll: !!m.keepScroll });
          s.view.all = false;
          break;
        case 'select': s.selected = pathOf(m.p); this.lastActive = s; this.postForm(s); break;
        case 'rendered':
          if (!s.counted && m.gen === s.gen) {
            s.counted = true;
            if (s.jdoc && s.jdoc.errors.length) this.hooks.rating.failure();
            else if (!(this.hooks.isSample && this.hooks.isSample(document.uri))) this.hooks.rating.success(document.uri);
          }
          s.last = m;
          s.renderedResolve(m);
          break;
        case 'op':
          s.queue = s.queue.then(() => this.onOp(s, m)).catch((e) => post({ type: 'error', message: String((e && e.message) || e).split('\n')[0] }));
          break;
        case 'reveal': this.reveal(s, pathOf(m.p)); break;
        case 'openText': vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', { viewColumn: vscode.ViewColumn.Beside, preview: false }); break;
        case 'undo': case 'redo': vscode.commands.executeCommand(m.type); break;
        default: break;
      }
    }));
    subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== document || !e.contentChanges.length) return;
      clearTimeout(s.timer);
      // our own edit redraws at once; a change from the text editor waits for typing to pause
      const own = document.getText() === s.lastWritten;
      s.timer = setTimeout(() => s.render({ keepScroll: true }), own ? 0 : 250);
    }));
    if (panel.onDidChangeViewState) subs.push(panel.onDidChangeViewState(() => { if (panel.active) this.lastActive = s; }));
    panel.onDidDispose(() => {
      clearTimeout(s.timer);
      for (const d of subs) { try { d.dispose(); } catch (e) { /* gone */ } }
      if (this.sessions.get(key) === s) this.sessions.delete(key);
      if (this.lastActive === s) this.lastActive = null;
    });
  }

  /** The parsed document of a session, parsed again only when the text changed. */
  docOf(s) {
    const v = s.document.version;
    if (!s.jdoc || v === undefined || s.version !== v) {
      const t = s.document.getText();
      if (s.jdoc && s.jdoc.text === t) { s.version = v; return s.jdoc; }
      s.jdoc = J.parse(t);
      s.version = v;
    }
    return s.jdoc;
  }

  render(s, extra = {}) {
    s.gen++;
    const doc = this.docOf(s);
    const v = s.view;
    let res, matches = 0;
    if (v.filter) { res = J.searchRows(doc, v.filter); matches = res.matches; } else res = J.buildRows(doc, { expanded: v.expanded, limits: v.limits, all: v.all });
    if (!v.filter && v.all) s.view.expanded = res.expanded;
    const json5 = /\.json5$/i.test(s.document.uri.path);
    const st = doc.errors.length ? null : J.stats(doc);
    const msg = {
      type: 'rows', gen: s.gen, rows: res.rows, truncated: !!res.truncated, filter: v.filter || '', matches,
      expanded: v.filter ? undefined : (v.all ? res.expanded : undefined),
      readOnly: s.readOnly, errors: doc.errors.slice(0, 5), errorCount: doc.errors.length, empty: doc.empty && !doc.errors.length,
      json5, comments: doc.hasComments, size: doc.text.length, stats: st, keepScroll: !!extra.keepScroll, first: !!extra.first,
      lineCount: doc.lines.length,
    };
    s.post(msg);
    this.postForm(s);
    return msg;
  }

  postForm(s) {
    const doc = this.docOf(s);
    s.post({ type: 'form', form: formOf(doc, s.selected || []), readOnly: s.readOnly || doc.errors.length > 0 });
  }

  /** Applies a tree or form edit: { type: 'op', op, p, value?, asString?, key?, to?, t? }. */
  async onOp(s, m) {
    if (s.readOnly) throw new Error('This file is read-only here.');
    const doc = this.docOf(s);
    const path = pathOf(m.p);
    let text, newPath = path;
    switch (m.op) {
      case 'set': text = J.setValue(doc, path, String(m.value ?? ''), !!m.asString); break;
      case 'rename': {
        const k = String(m.key ?? '');
        text = J.renameKey(doc, path, k);
        newPath = [...path.slice(0, -1), k];
        break;
      }
      case 'delete': text = J.remove(doc, path); newPath = path.slice(0, -1); break;
      case 'add': { const r = J.addChild(doc, path, '""'); text = r.text; newPath = r.path; break; }
      case 'duplicate': { const r = J.duplicate(doc, path); text = r.text; newPath = r.path; break; }
      case 'move': { const r = J.move(doc, path, m.to); text = r.text; newPath = r.path; break; }
      case 'type': text = J.changeType(doc, path, String(m.t)); break;
      case 'init': if (!doc.empty) throw new Error('The file is not empty.'); text = m.t === 'array' ? '[]\n' : '{}\n'; newPath = []; break;
      default: throw new Error(`Unknown edit: ${m.op}`);
    }
    const changed = await this.writeText(s, text);
    s.selected = newPath;
    if (!changed) this.render(s, { keepScroll: true });
    s.post({ type: 'done', op: m.op, p: J.pkey(newPath), changed, edit: m.op === 'add' });
    return changed;
  }

  /** Writes new text as one minimal replace. Returns false when nothing changed. */
  async writeText(s, newText) {
    const doc = s.document;
    const old = doc.getText();
    const e = J.minimalEdit(old, newText);
    if (!e) return false;
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
    s.lastWritten = newText;
    if (!(await vscode.workspace.applyEdit(we))) { s.lastWritten = null; throw new Error('VS Code did not accept the edit'); }
    return true;
  }

  /** Shows the value's line in the text editor beside the tree, with the value selected. */
  async reveal(s, path) {
    const doc = this.docOf(s);
    const n = doc.at(path);
    if (!n) return null;
    const node = n.parent && n.parent.type === 'property' ? n.parent : n;
    // the cursor at the start of the value, the value selected
    const sel = new vscode.Selection(s.document.positionAt(node.offset + node.length), s.document.positionAt(node.offset));
    const ed = await vscode.window.showTextDocument(s.document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    if (ed) { try { ed.selection = sel; } catch (e) { /* read-only editor */ } }
    if (ed && ed.revealRange) ed.revealRange(sel, vscode.TextEditorRevealType ? vscode.TextEditorRevealType.InCenterIfOutsideViewport : undefined);
    return ed;
  }

  activeSession() {
    for (const s of this.sessions.values()) if (s.panel.active) return s;
    return this.lastActive && this.sessions.has(this.lastActive.document.uri.toString()) ? this.lastActive : null;
  }
  activeUri() { const s = this.activeSession(); return s ? s.document.uri : null; }
  sessionOf(uri) { return uri ? this.sessions.get(uri.toString()) || null : null; }
}

function pathOf(p) {
  if (Array.isArray(p)) return p;
  try { const v = JSON.parse(String(p)); return Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number') : []; } catch (e) { return []; }
}
const arr = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 50000) : []);
const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});

module.exports = { JsonEditorProvider, VIEW_TYPE, formOf, pathOf };
