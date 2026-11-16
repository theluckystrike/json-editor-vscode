'use strict';
// REACH1: this listing's Pro tools for the editor toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'jsonEditor',
  triesKey: 'jsonEditor.proTrial',
  slot: '.reach-slot',
  tools: [
    { id: 'table', title: 'Table mode', command: 'jsonEditor.table' },
    { id: 'bulk', title: 'Bulk edit by JSONPath', command: 'jsonEditor.bulk' },
    { id: 'compare', title: 'Compare and merge', command: 'jsonEditor.compare' },
  ],
};
