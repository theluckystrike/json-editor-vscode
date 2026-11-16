'use strict';
// Webview HTML for the tree editor and the table. Kept free of the vscode module so tests can check the CSP: no
// remote origin anywhere (default-src 'none'); the script and the style sheet come from the extension's media folder,
// inline style and script only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'jsonEditor';

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

function page(p, body, script) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const footer = p.footer === false ? '' : footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.media('editor.css'))}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${escapeAttr(p.title || 'JSON Editor')}</title>
</head>
${body.replace('%FOOTER%', () => footer)}
<script nonce="${n}" src="${escapeAttr(p.media(script))}"></script>
</html>`;
}

/** p: { cspSource, media(name) -> uri string, title, nonce?, showSupportLinks?, head?(nonce) } */
function editorHtml(p) {
  return page(p, `<body class="tree-page">
<div id="app">
  <div id="toolbar" role="toolbar" aria-label="JSON editor">
    <input id="search" type="search" placeholder="Search keys and values" aria-label="Search keys and values">
    <span id="matches" class="muted"></span>
    <button id="expandAll" title="Open every object and array">Expand all</button>
    <button id="collapseAll" title="Close every object and array">Collapse all</button>
    <button id="formBtn" class="toggle on" aria-pressed="true" title="Show the fields of the selected object as a form">Form</button>
    <button id="openText" title="Open the file in the normal text editor beside this tree">Text</button>
    <span class="spacer"></span>
    <span class="reach-slot"></span>
  </div>
  <div id="banner" hidden></div>
  <div id="split">
    <div id="main" tabindex="0" role="tree" aria-label="JSON tree">
      <div id="rows"></div>
      <div id="empty" hidden></div>
    </div>
    <aside id="form" aria-label="Form of the selected object"></aside>
  </div>
  <div id="statusbar"><span id="status" class="muted">Opening...</span><span id="note"></span></div>
  <div id="footer">%FOOTER%</div>
</div>
</body>`, 'editor.js');
}

/** The table of an array of objects (Zovo Pro Table mode). */
function tableHtml(p) {
  return page({ ...p, footer: false }, `<body class="table-page">
<div id="app">
  <div id="toolbar" role="toolbar" aria-label="Table">
    <input id="filter" type="search" placeholder="Filter rows" aria-label="Filter rows">
    <button id="addColumn" title="Add a key to every row that does not have it">Add column</button>
    <button id="exportCsv" title="Save the rows shown (sorted and filtered) as a CSV file">Export CSV</button>
    <span class="spacer"></span>
    <span id="where" class="muted"></span>
  </div>
  <div id="banner" hidden></div>
  <div id="main"><table id="grid" aria-label="Rows"><thead></thead><tbody></tbody></table></div>
  <div id="statusbar"><span id="status" class="muted">Opening...</span><span id="note"></span></div>
</div>
</body>`, 'table.js');
}

module.exports = { editorHtml, tableHtml, csp, escapeAttr };
