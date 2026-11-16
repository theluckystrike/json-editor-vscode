# JSON Editor, Tree & Form View 0.1.0 (zovo.zovo-json-editor)

New listing, staged only. NICHE7 row 2, built by lane NEWB14 (seat zovo-team). Not published, not pushed.

- vsix: out/NEWB14-dist/zovo.zovo-json-editor/zovo.zovo-json-editor-0.1.0.vsix
- sha256: 6ce43a3bf0434089eeb8f50ecc167f8fce43a9dc616f87ea3b702905e2601b25 (249,528 bytes, 44 files)
- Product repo: factory/products/json-editor-vscode, local git only (no remote). The vsix was packaged from commit 5e380b6; the commit after it only adds this RELEASE.md, which .vscodeignore leaves out of the vsix.
- Unit tests: 244 of 244 pass with `npm test` (scripts/test.js). `node --test` in the repo runs 246 of 246. They cover parsing, rows, search, every tree edit (only the edited text changes, CRLF and tabs kept, inline and multi-line style kept), JSONPath, bulk edit, compare and merge, table mode and CSV, 7 real files, the extension against a vscode stub (each Pro tool A then B, Escape uses no try, reload keeps the count, the count never goes down), the webview CSP, and the license and rating tests copied by apply.sh.
- Real-app gate: VS Code 1.142.0 on port 9452 through buildslot, run r6 on this exact vsix: 80 PASS, 0 FAIL (out/NEWB14-data/json-editor/json-gate-r6.json and .tsv, log r6.log, screenshots out/NEWB14-data/json-editor/shots/json-r6-*.png).

## What it is

- Display name: JSON Editor, Tree & Form View (29 characters). The phrase "json editor" comes first, and the description starts with "JSON editor".
- Keywords: json editor, json, json tree, json form, dark mode. Engines: ^1.75.0. Activation: onUri only, plus the implicit custom editor and command events.
- Free core: a custom text editor (view type jsonEditor.tree) for *.json, *.jsonc and *.json5 with priority "option", so the text editor stays the default. It opens from the pencil button on a JSON text tab (beside the text), the Explorer, or the Command Palette.
  - Tree with expand and collapse, Expand all and Collapse all, 200 children at a time with "Show more", and up to 20,000 rows.
  - Double-click to edit a value or a key. The selected row has a type menu and Add, Duplicate and Delete buttons. Rows can be dragged within their parent. Keyboard: arrows, Enter, F2, Delete, Ctrl/Cmd+D, Ctrl/Cmd+Z.
  - A form of the selected object or array beside the tree, with text and number boxes, checkboxes and links into nested values.
  - Search keys and values, and a line-number click that selects the value in the text beside.
  - Exact big numbers, theme colors, and comments and trailing commas allowed. A file with a syntax error opens read-only with line and column. Empty files get "start with an object or an array" buttons.
- Edits: src/core/jdoc.js computes the new text on top of the jsonc-parser tree. A changed value or key replaces only its own text. An inserted, removed or moved entry follows its neighbours (same line or one per line, indent, line ending). Each change goes in as one minimal WorkspaceEdit, so undo, redo, the dirty state and save are VS Code's own.
- Zovo Pro tools (1 free try each; module 2026-11-15.conv2, TRIES_MAX 1; listing tag "jsoned"; tries key jsonEditor.proTrial; TRIAL_USES = 1 in src/pro.js only; no triesMax in factory/sprint/license/proinfo/jsoned.json):
  - Table mode: an array of objects as a table beside the tree. It has sort, a filter, cell edits (a missing key is added), Add column (null in every row that lacks it) and CSV export of the rows shown, in their order. The try counts when the table is drawn.
  - Bulk edit by JSONPath: query with a live match count, then an action: set, rename key, delete, upper or lower case, trim, to text or to number. A preview pick shows every change, and the edit goes in as one undoable edit. The try counts when the edit is applied.
  - Compare and merge: pick another workspace JSON file or browse. A Markdown report opens beside, and the try counts then. A multi-pick then copies the ticked changes into this file.
- No clash with our Large JSON Viewer (zovo.zovo-json-tree-viewer): different view type, command ids (jsonEditor.* vs jsonTreeViewer.*) and title button icon ($(edit) vs $(list-tree)). The walkthrough and README link to it.
- Nothing pops up on open. The webview CSP is default-src 'none' with nonce scripts and no inline style attributes. The extension makes no network calls. The Pro panel shows only after a click on a Pro tool with no tries left.
- Vendored: jsonc-parser 3.3.1 (MIT, Microsoft), lib/umd files unchanged in lib/jsonc-parser, listed in THIRD-PARTY-NOTICES.md. src/ is plain files. src/license/*.js and src/rate.js are byte-identical to factory/sprint (checked with cmp and lead-check.sh).

## Samples used

- Shipped: samples/shop-catalog.jsonc (ours, a made-up garden shop: comments, a 64-bit number, arrays of objects).
- Test and gate fixtures (ours, not in the vsix): broken.json, settings.json5 (JSON5 syntax), crlf-tabs.json (also copied as CONFIG.JSON in the gate), empty.json, orders-a.json, orders-b.json, and a zones.json and a generated 44.7 MB big.json (210,000 records with ids above 2^53) made by the gate script.
- Real third-party files, downloaded 15 Nov into newb14-work/json-editor/dl (own folder each, never executed), now in test/fixtures/real with SOURCES.txt:
  - microsoft/vscode (MIT): extensions/typescript-basics/language-configuration.json (comments), .vscode/settings.json (20 comment lines), extensions/git/package.json (139 KB), src/tsconfig.json.
  - nst/JSONTestSuite (MIT): y_object_duplicated_key.json, y_string_accepted_surrogate_pair.json, n_structure_unclosed_array.json (broken).

## Gate coverage (r6)

- A .jsonc file opens as text (the tree is not the default) and nothing pops up. The pencil title button opens the tree beside the text, and the text tab stays.
- The gate reads the status ("14 objects, 8 arrays, 61 values · 39 lines · 1.5 KB · comments kept"), the exact 64-bit number and the form fields. Dark Modern colors: background luminance 0.12, text 0.80.
- Edits like a user, then checks the bytes on disk after a save:
  - Double-click and typing changed a value, a key and a 64-bit number. Only those 3 lines changed and the comments stayed.
  - Duplicate button, Delete key, + Add with a typed key, the type menu, a drag, and typing in a form field.
  - One Cmd+Z in the tree undid exactly the last change.
  - The tree followed a change of the file on disk.
  - Search "watering" gave 5 matches. A line-number click selected the value in the text at Ln 13, Col 7.
- Real files: the 4 microsoft/vscode files and the surrogate-pair file open without error and stay unchanged on disk. The Git extension package.json shows 3,511 rows after Expand all. The duplicated-key file marks the first key as repeated.
- Broken files: broken.json, the unclosed array and the JSON5 file open read-only with line and column messages, no toast, and stay unchanged. empty.json gets {} from its button.
- The Explorer right-click on CONFIG.JSON (upper case) shows the editor entry and 3 "Zovo Pro: ..." entries. An entry added there keeps CRLF and tabs.
- big.json (44.7 MB) opens in 4.3 s with full counts. Expanding 210,000 records shows 200 rows and "Show 200 more".
- Pro tools on file A, with their output checked:
  - Table mode from the toolbar row on the selected products array: 6 rows and 6 columns, sort by price, a cell edit (41.5), Add column (discount: null in 6 rows), and a CSV of the filtered row with quoted fields.
  - Bulk edit from the palette: "2 matches" while typing, the action list, a preview "Apply 2 changes", both qty values set to 7 on disk and nothing else changed.
  - Compare and merge: the report (6 differences: 3 changed, 2 only in B, 1 only in A), then the 2 ticked changes copied into orders-a.json and saved. orders-b.json stayed unchanged.
- File B for each tool (Explorer entry, palette or toolbar row) opens the Pro panel right after the click ("You used the free try of ...") and opens no table, query box or file pick.
- The info tab (from the palette) shows "no free tries left" for Table mode and Bulk edit, "1 free try left" for Compare and merge, and USD 19 once. No URL was opened.
- After a restart of VS Code, the toolbar row says "0 tries left" for all 3 tools, and a click opens the Pro panel.
- At the end: no error toasts, no CSP violations, no webview network requests, no extension-host sockets, no webview console errors, no URL opened, and no gate process left.

## Defects found and fixed

- Unit stage:
  - jsonc-parser's modify() reformatted whole lines around an insert. Inserts, removals and moves are now our own text edits that keep the neighbours' style.
  - Repeated keys: edits went to the first key while JSON readers use the last one. Now the last one wins and the first is shown as a read-only "repeated key".
  - Writing an unchanged string back rewrote its escapes (𐐷 became the literal character). The text is now kept when the value is the same.
- Gate r1 and r2 (product):
  - Inline style attributes on tree rows broke the webview CSP (2 violations). The indent is now set through the CSS object model.
  - The key typed right after "+ Add" was lost when a second redraw arrived during typing, so the key stayed "newKey". Redraws now wait while an inline edit is open.
  - The line-number jump left the cursor at the end of the value (Col 23). It now puts the cursor at the start, with the value selected.
  - Bulk edit's "changed N values" status message covered the "free try used" message. They now come in the other order.
  - Keys had the plain text color in the dark theme. They now use the theme's symbol color (blue in Dark Modern).
- Gate script (not product): the search expectation, the surrogate status pattern and the info tab (opened from the palette, since the toolbar's "Get Zovo Pro" goes to the card page after CONV2). Runs r3 to r5 on this same sha each had 1 FAIL in the compare save check: the gate saved the wrong tab, and the dirty-tab match "orders-a" also matched the untitled report title. On disk the copy itself was right in r5.
- Release blocker fixed: test/rate-link.test.js from factory/sprint/rating was the pre-EXEC16 copy and failed 2 tests against the Zovo Pro footer. It now matches the template listings.

## Known limits

- Not built from the row's Pro list: the schema-driven form (Pro idea 2), paste from Excel or CSV and XLSX export in Table mode, and copying changes from this file into the other one in Compare and merge.
- Compare matches arrays by position, not by an id field.
- JSON5 beyond comments and trailing commas is read-only. The 50 MB claim was tested with a 44.7 MB file.
- The tree shows at most 20,000 rows and the form 300 fields. Text values over 4,000 characters are edited in the text editor. Drag works only within the same parent. A comment above a moved entry stays where it was.
- Gate method: the drag used DragEvents dispatched in the webview, and the type menu and the Table mode controls were driven with DOM events. The CSV export used VS Code's simple file dialog setting. The Pro panels were closed with Cancel. The TEST-key patch of the installed copy (CARD1 method) ran in setup, but this gate has no licensed step.
