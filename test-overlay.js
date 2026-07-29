'use strict';
// Headless end-to-end check of overlay ("keep") semantics against real
// ~/.claude data, using a throwaway overlays dir. Read-only on real files.
// Usage: node test-overlay.js <workspaceRoot> <overlaysTmpDir>
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

(async () => {
  const root = process.argv[2] || process.cwd();
  const overlaysDir = process.argv[3];
  if (!overlaysDir) { console.error('need overlays tmp dir'); process.exit(1); }
  const opts = { lookbackMs: 48 * 3600e3, maxSessions: 6 };

  const before = await lib.computeChanges([root], opts);
  const all = before.flatMap((g) => g.changes);
  const target = all.find((c) => c.status === 'modified' && c.snapshotPath);
  if (!target) { console.log('SKIP: no modified change with snapshot found'); return; }
  console.log(`target: ${target.absPath} (session ${target.sessionId.slice(0, 8)})`);

  const baseText = fs.readFileSync(target.snapshotPath, 'utf8');
  const curText = fs.readFileSync(target.absPath, 'utf8');
  const hunks = lib.computeHunks(baseText, curText);
  console.log(`hunks: ${hunks.length}`);
  if (!hunks.length) { console.error('FAIL: modified file but zero hunks'); process.exit(1); }

  const op = lib.overlayPathFor(overlaysDir, target.absPath);
  fs.mkdirSync(path.dirname(op), { recursive: true });

  // keep ONE hunk -> file should still be listed (if it had >1 hunks), with fewer hunks vs overlay
  const nb = lib.applyHunkToBase(baseText.split('\n'), curText.split('\n'), hunks[0]);
  fs.writeFileSync(op, nb.join('\n'));
  const mid = await lib.computeChanges([root], { ...opts, overlaysDir });
  const midCh = mid.flatMap((g) => g.changes).find((c) => c.absPath === target.absPath);
  if (hunks.length > 1) {
    if (!midCh) { console.error('FAIL: file vanished after keeping only one of several hunks'); process.exit(1); }
    if (midCh.baselinePath !== op) { console.error('FAIL: baseline is not the overlay'); process.exit(1); }
    const midHunks = lib.computeHunks(fs.readFileSync(op, 'utf8'), curText);
    if (midHunks.length >= hunks.length) { console.error('FAIL: hunk count did not shrink'); process.exit(1); }
    console.log(`after keep-one: still listed, ${midHunks.length} hunk(s) remain — OK`);
  } else {
    if (midCh) { console.error('FAIL: single-hunk file still listed after keeping it'); process.exit(1); }
    console.log('after keep-one (only hunk): file dropped off the list — OK');
  }

  // keep ALL -> overlay == current -> file must drop off the list
  fs.writeFileSync(op, curText);
  const after = await lib.computeChanges([root], { ...opts, overlaysDir });
  const afterCh = after.flatMap((g) => g.changes).find((c) => c.absPath === target.absPath);
  if (afterCh) { console.error('FAIL: file still listed after keeping everything'); process.exit(1); }
  console.log('after keep-all: file dropped off the list — OK');

  // remove overlay -> full diff returns
  fs.rmSync(op);
  const restored = await lib.computeChanges([root], { ...opts, overlaysDir });
  const restoredCh = restored.flatMap((g) => g.changes).find((c) => c.absPath === target.absPath);
  if (!restoredCh) { console.error('FAIL: file did not return after overlay removal'); process.exit(1); }
  console.log('overlay removed: full diff returns — OK');
  console.log('ALL OVERLAY CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
