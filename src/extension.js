'use strict';
// JSON Editor, Tree & Form View by Zovo. Free core: .json, .jsonc and .json5 files open (on request; the text editor
// stays the default) in a tree with a form of the selected object beside it. Keys and values are edited in place,
// entries added, duplicated, deleted, dragged to a new place and given another type. Every change goes into VS Code's
// own text document as a replace of only the edited text, so comments, key order and formatting stay, and undo, redo
// and save are VS Code's own. No network and no telemetry; nothing shows on activation. Pro tools (pro.js) ask only
// when used: Table mode, Bulk edit by JSONPath, Compare and merge.
const vscode = require('vscode');
const { JsonEditorProvider, VIEW_TYPE } = require('./editor');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const EXT_ID = 'zovo.zovo-json-editor';
const PREFIX = 'jsonEditor';
const JSON_RE = /\.(json|jsonc|json5)$/i;

let pro, reach, editors, tools, ctxRef;

function setting(key, dflt) { try { const v = vscode.workspace.getConfiguration(PREFIX).get(key, dflt); return v === undefined ? dflt : v; } catch (e) { return dflt; } }
const isSample = (uri) => !!(ctxRef && uri && uri.scheme === 'file' && (uri.fsPath.startsWith(ctxRef.extensionUri.fsPath) || (ctxRef.globalStorageUri && uri.fsPath.startsWith(ctxRef.globalStorageUri.fsPath))));
function refreshPro() { if (reach) reach.refresh(); }
const asUri = (a) => (a && a.scheme ? a : null);
const asOpts = (o) => (o && typeof o === 'object' && !Array.isArray(o) && !o.scheme ? o : {});

function activate(context) {
  ctxRef = context;
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'JSON Editor' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  editors = new JsonEditorProvider(context, { rating, reach, isSample });
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, editors, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  tools = createTools({ pro, editors, context });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro(); }));

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e).split('\n')[0]); return undefined; }
  }));
  reg(`${PREFIX}.open`, async (uri) => {
    const u = tools.targetUri(asUri(uri));
    if (!u) { vscode.window.showInformationMessage('Open a .json, .jsonc or .json5 file first.'); return; }
    // From the JSON text tab: the tree opens beside it, so the text stays where it is.
    const t = vscode.window.activeTextEditor;
    const beside = !!(t && t.document.uri.toString() === u.toString());
    await vscode.commands.executeCommand('vscode.openWith', u, VIEW_TYPE, { viewColumn: beside ? vscode.ViewColumn.Beside : undefined, preview: false });
  });
  reg(`${PREFIX}.openAsText`, async (uri) => {
    const u = tools.targetUri(asUri(uri));
    if (!u) { vscode.window.showInformationMessage('Open a JSON file first.'); return; }
    await vscode.commands.executeCommand('vscode.openWith', u, 'default', { viewColumn: vscode.ViewColumn.Beside, preview: false });
  });
  reg(`${PREFIX}.openSample`, async () => {
    // A copy in the extension's storage, so edits never touch the installed extension.
    const src = vscode.Uri.joinPath(context.extensionUri, 'samples', 'shop-catalog.jsonc');
    const dst = vscode.Uri.joinPath(context.globalStorageUri, 'shop-catalog.jsonc');
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    let exists = true; try { await vscode.workspace.fs.stat(dst); } catch (e) { exists = false; }
    if (!exists) await vscode.workspace.fs.writeFile(dst, await vscode.workspace.fs.readFile(src));
    await vscode.commands.executeCommand('vscode.openWith', dst, VIEW_TYPE, { preview: false });
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.table`, reach.wrap((uri, opt) => tools.tableTool(asUri(uri), asOpts(opt))));
  reg(`${PREFIX}.bulk`, reach.wrap((uri, opt) => tools.bulkTool(asUri(uri), asOpts(opt))));
  reg(`${PREFIX}.compare`, reach.wrap((uri, opt) => tools.compareTool(asUri(uri), asOpts(opt))));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { editors: () => editors, pro: () => pro, tools: () => tools };
}

function deactivate() {}

module.exports = { activate, deactivate, JSON_RE, _internal: { editors: () => editors, pro: () => pro, tools: () => tools } };
