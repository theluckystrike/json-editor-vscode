'use strict';
// The three Zovo Pro tools: Table mode, Bulk edit by JSONPath, Compare and merge. Each checks the free try first (the
// Pro panel shows right after the click when the try is used) and counts the try only after its result is there.
// All of them edit the file through VS Code's text document as one replace, so a single undo takes a change back.
const vscode = require('vscode');
const path = require('path');
const J = require('./core/jdoc');
const T = require('./core/table');
const B = require('./core/bulk');
const D = require('./core/diff');
const { query } = require('./core/jsonpath');
const { tableHtml } = require('./html');

const JSON_RE = /\.(json|jsonc|json5)$/i;
const EXCLUDE = '**/{node_modules,.git,.venv,venv,dist,out}/**';

function createTools({ pro, editors, context }) {
  const base = (u) => path.posix.basename(u.path);
  const tables = new Set();
  let lastExpr = '$..';

  /** The file a tool works on: the clicked file, else the active tree editor, else the active text editor. */
  function targetUri(arg) {
    if (arg && arg.scheme) return arg;
    const a = editors && editors.activeUri();
    if (a) return a;
    const t = vscode.window.activeTextEditor;
    return t ? t.document.uri : null;
  }
  async function jsonTarget(arg) {
    const u = targetUri(arg);
    if (!u) { vscode.window.showInformationMessage('Open a JSON file first.'); return null; }
    const doc = await vscode.workspace.openTextDocument(u);
    const jd = J.parse(doc.getText());
    if (jd.errors.length) { vscode.window.showErrorMessage(`${base(u)} has a syntax error: ${jd.errors[0].message}. Fix it first.`); return null; }
    if (!jd.root) { vscode.window.showInformationMessage(`${base(u)} is empty.`); return null; }
    return { uri: u, doc, jd };
  }
  /** One minimal replace in the text document (not saved). */
  async function writeDoc(doc, newText) {
    const e = J.minimalEdit(doc.getText(), newText);
    if (!e) return false;
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
    if (!(await vscode.workspace.applyEdit(we))) throw new Error(`VS Code did not accept the edit of ${base(doc.uri)}`);
    return true;
  }
  const selectedPath = (uri) => { const s = editors && editors.sessionOf(uri); return s ? s.selected || [] : []; };

  // ---------- 1. Table mode ----------
  async function tableTool(arg, opts = {}) {
    if (!(await pro.allowed('table', arg))) return undefined;
    const t = await jsonTarget(arg);
    if (!t) return undefined;
    const arrays = T.findArrays(t.jd);
    if (!arrays.length) { vscode.window.showInformationMessage(`${base(t.uri)} has no array of objects to show as a table.`); return undefined; }
    let p = Array.isArray(opts.path) ? opts.path : null;
    if (!p) {
      // the selected value in the tree, or the closest array of objects above it
      const sel = selectedPath(t.uri);
      const hit = arrays.filter((a) => a.path.length <= sel.length && a.path.every((k, i) => k === sel[i])).sort((a, b) => b.path.length - a.path.length)[0];
      if (hit) p = hit.path;
    }
    if (!p && arrays.length === 1) p = arrays[0].path;
    if (!p) {
      const pick = await vscode.window.showQuickPick(arrays.map((a) => ({ label: a.where, description: `${a.rows} rows, ${a.columns} columns`, a })), { placeHolder: 'Pick the array to open as a table', ignoreFocusOut: true });
      if (!pick) return undefined;
      p = pick.a.path;
    }
    return openTable(t.doc, p);
  }

  function openTable(doc, p) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const where = T.model(J.parse(doc.getText()), p).where;
    const panel = vscode.window.createWebviewPanel('jsonEditor.table', `Table: ${base(doc.uri)} ${where}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, localResourceRoots: [media], enableCommandUris: false });
    const wv = panel.webview;
    wv.html = tableHtml({ cspSource: wv.cspSource, media: (n) => wv.asWebviewUri(vscode.Uri.joinPath(media, n)).toString(), title: 'Table mode' });
    const st = { panel, doc, path: p, gen: 0, counted: false, rendered: null, renderedResolve: null, timer: null, last: null };
    st.rendered = new Promise((r) => { st.renderedResolve = r; });
    const post = (m) => { try { const r = wv.postMessage(m); return r && r.then ? r.then(undefined, () => false) : Promise.resolve(r); } catch (e) { return Promise.resolve(false); } };
    const send = () => {
      st.gen++;
      const jd = J.parse(doc.getText());
      if (jd.errors.length) return post({ type: 'table', gen: st.gen, model: { columns: [], rows: [], total: 0, where }, readOnly: true, error: `The file has a syntax error: ${jd.errors[0].message}` });
      let model;
      try { model = T.model(jd, p); } catch (e) { return post({ type: 'table', gen: st.gen, model: { columns: [], rows: [], total: 0, where }, readOnly: true, error: String(e.message || e) }); }
      return post({ type: 'table', gen: st.gen, model, readOnly: false });
    };
    const note = (text) => post({ type: 'note', text });
    const subs = [];
    subs.push(wv.onDidReceiveMessage(async (m) => {
      if (!m || typeof m !== 'object') return;
      try {
        if (m.type === 'ready') send();
        else if (m.type === 'rendered') {
          st.last = m;
          if (!st.counted && m.gen >= 1) { st.counted = true; await pro.produced('table'); }
          st.renderedResolve(m);
        } else if (m.type === 'cell') {
          await writeDoc(doc, T.setCell(J.parse(doc.getText()), p, Number(m.i), String(m.col), String(m.value ?? ''), !!m.asString));
        } else if (m.type === 'addColumn') {
          const name = await vscode.window.showInputBox({ prompt: 'Name of the new column. Every row that does not have this key gets it with the value null.', placeHolder: 'column name', ignoreFocusOut: true });
          if (!name || !name.trim()) return;
          const r = T.addColumn(J.parse(doc.getText()), p, name.trim());
          await writeDoc(doc, r.text);
          note(`Column "${name.trim()}" added to ${r.added} row${r.added === 1 ? '' : 's'}.`);
        } else if (m.type === 'exportCsv') {
          const jd = J.parse(doc.getText());
          const last = p.length ? String(p[p.length - 1]) : 'rows';
          const def = vscode.Uri.joinPath(doc.uri, '..', `${base(doc.uri).replace(JSON_RE, '')}-${last.replace(/[^\w.-]+/g, '_')}.csv`);
          const out = await vscode.window.showSaveDialog({ defaultUri: def, filters: { CSV: ['csv'] }, saveLabel: 'Export CSV' });
          if (!out) return;
          const order = Array.isArray(m.order) ? m.order.map(Number).filter((x) => Number.isInteger(x) && x >= 0) : null;
          await vscode.workspace.fs.writeFile(out, Buffer.from(T.toCsv(jd, p, order), 'utf8'));
          note(`Saved ${base(out)} (${(order || []).length} rows).`);
          vscode.window.setStatusBarMessage(`JSON Editor: saved ${base(out)}`, 6000);
        }
      } catch (e) {
        note(String((e && e.message) || e).split('\n')[0]);
      }
    }));
    subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== doc || !e.contentChanges.length) return;
      clearTimeout(st.timer);
      st.timer = setTimeout(send, 150);
    }));
    tables.add(st);
    panel.onDidDispose(() => { clearTimeout(st.timer); tables.delete(st); for (const d of subs) { try { d.dispose(); } catch (e) { /* gone */ } } });
    return st;
  }

  // ---------- 2. Bulk edit ----------
  async function bulkTool(arg, opts = {}) {
    if (!(await pro.allowed('bulk', arg))) return undefined;
    const t = await jsonTarget(arg);
    if (!t) return undefined;
    let expr = typeof opts.expr === 'string' ? opts.expr : null;
    if (expr === null) {
      const sev = vscode.InputBoxValidationSeverity;
      expr = await vscode.window.showInputBox({
        title: `Bulk edit ${base(t.uri)}`,
        prompt: 'JSONPath of the values to change, for example $..price, $.items[*].name, $.items[?(@.active == false)] or .items[].id',
        value: lastExpr, ignoreFocusOut: true,
        validateInput: (v) => {
          try { const n = query(t.jd, v).length; return n ? (sev ? { message: `${n} match${n === 1 ? '' : 'es'}`, severity: sev.Info } : null) : 'No match yet'; } catch (e) { return String(e.message || e); }
        },
      });
      if (expr === undefined || !expr.trim()) return undefined;
    }
    lastExpr = expr;
    let action = opts.action;
    if (!action) {
      const pick = await vscode.window.showQuickPick(Object.entries(B.ACTIONS).map(([id, a]) => ({ label: a.label, id })), { placeHolder: `What to do with the values that match ${expr}`, ignoreFocusOut: true });
      if (!pick) return undefined;
      action = pick.id;
    }
    let argv = opts.value;
    const need = B.ACTIONS[action] && B.ACTIONS[action].needs;
    if (need && argv === undefined) {
      argv = await vscode.window.showInputBox({ prompt: need === 'key' ? 'New key name' : 'New value as JSON: 12, true, null, "text in quotes", {"a": 1}. Anything that is not JSON is stored as text.', ignoreFocusOut: true });
      if (argv === undefined) return undefined;
    }
    const jd = J.parse(t.doc.getText());
    const plan = B.plan(jd, expr, action, argv);
    if (!plan.changes.length) {
      vscode.window.showInformationMessage(plan.matches ? `Nothing to change: ${plan.matches} match${plan.matches === 1 ? '' : 'es'}, none of them needs this change.` : `No value matches ${expr}.`);
      return { changes: 0 };
    }
    if (opts.confirm !== true) {
      const items = [{ label: `$(check) Apply ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`, description: plan.skipped ? `${plan.skipped} skipped` : '', apply: true },
        ...plan.changes.slice(0, 500).map((c) => ({ label: c.where, description: `${c.before}  →  ${c.after}` }))];
      const pick = await vscode.window.showQuickPick(items, { title: `Bulk edit preview: ${B.ACTIONS[action].label}, ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`, placeHolder: 'Pick "Apply" to change the file (one undo takes it back), Escape to cancel', ignoreFocusOut: true, matchOnDescription: true });
      if (!pick || !pick.apply) return undefined;
    }
    await writeDoc(t.doc, B.applyPlan(jd, plan.changes));
    vscode.window.setStatusBarMessage(`JSON Editor: bulk edit changed ${plan.changes.length} value${plan.changes.length === 1 ? '' : 's'} in ${base(t.uri)}. Undo takes it back.`, 8000);
    // after the change message, so the free try count is the one on top
    await pro.produced('bulk');
    return { changes: plan.changes.length, skipped: plan.skipped };
  }

  // ---------- 3. Compare and merge ----------
  async function readText(uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  }
  async function compareTool(arg, opts = {}) {
    if (!(await pro.allowed('compare', arg))) return undefined;
    const t = await jsonTarget(arg);
    if (!t) return undefined;
    let other = opts.other && opts.other.scheme ? opts.other : null;
    if (!other) {
      const files = (await vscode.workspace.findFiles('**/*.{json,jsonc,json5}', EXCLUDE, 500)).filter((u) => u.toString() !== t.uri.toString()).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      const rel = (u) => { try { return vscode.workspace.asRelativePath(u, false); } catch (e) { return u.fsPath; } };
      const items = [...files.map((u) => ({ label: base(u), description: rel(u), uri: u })), { label: '$(folder-opened) Browse...', browse: true }];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Compare ${base(t.uri)} with...`, ignoreFocusOut: true, matchOnDescription: true });
      if (!pick) return undefined;
      if (pick.browse) {
        const r = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json', 'jsonc', 'json5'] }, openLabel: 'Compare' });
        if (!r || !r.length) return undefined;
        other = r[0];
      } else other = pick.uri;
    }
    const jb = J.parse(await readText(other));
    const ja = J.parse(t.doc.getText());
    let diffs;
    try { diffs = D.compare(ja, jb); } catch (e) { vscode.window.showErrorMessage(String(e.message || e)); return undefined; }
    const nameA = base(t.uri), nameB = base(other) === nameA ? `${base(other)} (other)` : base(other);
    const rep = await vscode.workspace.openTextDocument({ content: D.report(diffs, nameA, nameB), language: 'markdown' });
    await vscode.window.showTextDocument(rep, { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: true });
    await pro.produced('compare');
    if (!diffs.length) { vscode.window.setStatusBarMessage(`JSON Editor: ${nameA} and ${nameB} have the same content (key order ignored).`, 8000); return { diffs: 0, copied: 0, report: rep }; }
    let picks = opts.pick;
    if (!picks) {
      const icon = { changed: '$(diff-modified)', added: '$(diff-added)', removed: '$(diff-removed)' };
      const items = diffs.slice(0, 1000).map((d) => ({ label: `${icon[d.kind]} ${d.where}`, description: d.kind === 'changed' ? `${d.a}  →  ${d.b}` : d.kind === 'added' ? `only in ${nameB}: ${d.b}` : `only in ${nameA}: delete it`, d }));
      const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: `${diffs.length} difference${diffs.length === 1 ? '' : 's'}. Tick the changes to copy from ${nameB} into ${nameA}`, placeHolder: 'Tick changes and press Enter; Escape keeps the file as it is', ignoreFocusOut: true, matchOnDescription: true });
      picks = chosen ? chosen.map((c) => c.d) : [];
    } else if (picks === 'all') picks = diffs;
    let copied = 0;
    if (picks.length) {
      const now = J.parse(t.doc.getText());
      await writeDoc(t.doc, D.merge(now, picks));
      copied = picks.length;
      vscode.window.setStatusBarMessage(`JSON Editor: copied ${copied} change${copied === 1 ? '' : 's'} from ${nameB} into ${nameA}. Undo takes it back.`, 8000);
    }
    return { diffs: diffs.length, copied, report: rep };
  }

  return { targetUri, tableTool, bulkTool, compareTool, tables, writeDoc };
}

module.exports = { createTools };
