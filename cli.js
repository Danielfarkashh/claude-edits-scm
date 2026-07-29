#!/usr/bin/env node
'use strict';
// Headless twin of the extension's data pipeline — runs the exact same lib.js
// the extension runs, without VS Code. Useful for scripting, debugging remote
// installs, and end-to-end tests (see test-e2e.js).
//
//   node cli.js changes <workspaceRoot> [--hours N] [--json] [--all]
//
// --all disables Claude-only attribution (shows every diff vs the baseline).
// Note: "keep" overlays live in VS Code extension storage, so the CLI always
// diffs against the pre-session snapshot.
const fs = require('fs');
const lib = require('./lib');

async function main() {
  const [cmd, root, ...rest] = process.argv.slice(2);
  if (cmd !== 'changes' || !root) {
    console.error('usage: node cli.js changes <workspaceRoot> [--hours N] [--json] [--all]');
    process.exit(2);
  }
  const hours = rest.includes('--hours') ? parseFloat(rest[rest.indexOf('--hours') + 1]) : 48;
  const claudeOnly = !rest.includes('--all');
  const groups = await lib.computeChanges([root], {
    lookbackMs: hours * 3600e3,
    maxSessions: 6,
    includeGlobs: ['**/.claude/**'],
    excludeGlobs: ['/tmp/claude-*/**'],
  });
  const out = [];
  for (const g of groups) {
    const entry = { sessionId: g.sessionId, title: g.title, changes: [] };
    for (const ch of g.changes) {
      let add = null;
      let del = null;
      let attributed = false;
      if (ch.status !== 'deleted' && fs.existsSync(ch.absPath)) {
        const effText = ch.baselinePath ? fs.readFileSync(ch.baselinePath, 'utf8') : '';
        const curText = fs.readFileSync(ch.absPath, 'utf8');
        let hunks = lib.computeHunks(effText, curText);
        if (claudeOnly && ch.ops && ch.ops.length) {
          const cf = await lib.claudeFinalFor(ch); // full replay, else anchored on last backup
          if (cf !== null) {
            hunks = lib.attributeHunks(effText, curText, hunks, cf, ch.claudeSnapText ?? "").filter((h) => h.claude);
            attributed = true;
          }
        }
        if (attributed && ch.status === 'modified' && !hunks.length) continue; // user-only edits
        add = hunks.reduce((n, h) => n + h.curCount, 0);
        del = hunks.reduce((n, h) => n + h.baseCount, 0);
      }
      entry.changes.push({ file: ch.absPath, status: ch.status, add, del, attributed });
    }
    if (entry.changes.length) out.push(entry);
  }
  if (rest.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const g of out) {
      console.log(`# ${g.title} (${g.sessionId.slice(0, 8)})`);
      for (const c of g.changes) {
        console.log(`  ${c.status.padEnd(8)} +${c.add ?? '?'} −${c.del ?? '?'}${c.attributed ? '' : ' (unattributed)'}  ${c.file}`);
      }
    }
    if (!out.length) console.log('no Claude changes found');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
