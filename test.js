'use strict';
// Headless smoke test of the data layer against the real ~/.claude data.
// Usage: node test.js [workspaceRoot] [lookbackHours]
const lib = require('./lib');

(async () => {
  const root = process.argv[2] || process.cwd();
  const hours = parseFloat(process.argv[3] || '48');
  console.log(`workspace root: ${root} (lookback ${hours}h)`);
  const groups = await lib.computeChanges([root], { lookbackMs: hours * 3600 * 1000, maxSessions: 6 });
  if (!groups.length) console.log('no Claude changes found');
  for (const g of groups) {
    console.log(`\n== session ${g.sessionId.slice(0, 8)}  "${g.title || ''}"  (jsonl mtime ${new Date(g.mtimeMs).toISOString()})`);
    for (const c of g.changes) {
      console.log(`   ${c.status.padEnd(8)} ${c.absPath}`);
      console.log(`            baseline: ${c.baselinePath || '(none — new file)'}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
