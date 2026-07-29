'use strict';
// file-history-delta tests: newer Claude Code emits one snapshot with an EMPTY
// trackedFileBackups map, then a `file-history-delta` record per edit instead of
// re-serializing the whole map. Reading only snapshots yields zero files and an
// empty view, so these lock in that both forms are folded into the same map.
// Self-contained — writes synthetic logs to a temp dir, no real ~/.claude data.
// Usage: node test-delta.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-delta-'));
let seq = 0;

function session(lines) {
  const sessionId = `dlta${String(++seq).padStart(4, '0')}-1111-2222-3333-444444444444`;
  const jsonlPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sessionId, jsonlPath, mtimeMs: fs.statSync(jsonlPath).mtimeMs };
}

const W = process.platform === 'win32' ? 'C:\\w' : '/w';
const emptySnap = { type: 'file-history-snapshot', snapshot: { trackedFileBackups: {} } };
const delta = (trackingPath, backup) => ({ type: 'file-history-delta', trackingPath, backup });
const backup = (backupFileName, version, realParentDir) => ({
  backupFileName, version, backupTime: '2026-07-28T12:00:00.000Z', realParentDir,
});
const userMsg = (text) => ({ type: 'user', cwd: W, message: { role: 'user', content: text } });
// Bulk line of the kind that dominates a real log — no file-history marker in it.
const noise = { type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(500) } };

async function filesOf(lines) {
  const parsed = await lib.parseSession(session(lines));
  return parsed.files;
}

(async () => {
  // --- the core regression: empty snapshot + deltas must still yield files ---
  {
    const files = await filesOf([
      userMsg('hi'),
      emptySnap,
      delta('lib.js', backup('415f940c220f3784@v1', 1, W)),
      delta('new.js', backup(null, 1, W)),
    ]);
    eq(files.size, 2, 'delta-only session yields both files');
    eq(files.get(path.join(W, 'lib.js')).backupFileName, '415f940c220f3784@v1', 'relative trackingPath resolved');
    eq(files.get(path.join(W, 'new.js')).backupFileName, null, 'null backupFileName => created');
  }

  // --- prefilter must not skip deltas AFTER the header scan is satisfied ---
  // cwd+prompt both land on line 1, so needHeader goes false immediately; a
  // prefilter matching only '"file-history-snapshot"' drops every delta below.
  {
    const files = await filesOf([
      userMsg('a real prompt'),
      ...Array(50).fill(noise),
      delta('late.js', backup('aaaaaaaaaaaaaaaa@v1', 1, W)),
    ]);
    eq(files.size, 1, 'delta after header scan completes is still read');
    assert(files.has(path.join(W, 'late.js')), 'late delta tracked');
  }

  // --- absolute trackingPath (Claude writes these for files outside the cwd) ---
  {
    const abs = path.join(W, 'sub', 'deep.js');
    const files = await filesOf([
      userMsg('hi'), emptySnap, delta(abs, backup(null, 1, path.join(W, 'sub'))),
    ]);
    eq(files.size, 1, 'absolute trackingPath yields one file');
    assert(files.has(abs), `absolute trackingPath resolved to ${abs}`);
  }

  // --- first delta wins: earliest entry carries the pre-session baseline ---
  {
    const files = await filesOf([
      userMsg('hi'), emptySnap,
      delta('a.js', backup('cafebabecafebabe@v1', 1, W)),
      delta('a.js', backup('cafebabecafebabe@v2', 2, W)),
      delta('a.js', backup('cafebabecafebabe@v3', 3, W)),
    ]);
    eq(files.size, 1, 'repeated deltas collapse to one entry');
    eq(files.get(path.join(W, 'a.js')).backupFileName, 'cafebabecafebabe@v1', 'lowest version kept');
  }

  // --- a created file must not be upgraded to modified by a later delta ---
  {
    const files = await filesOf([
      userMsg('hi'), emptySnap,
      delta('born.js', backup(null, 1, W)),
      delta('born.js', backup('ffffffffffffffff@v2', 2, W)),
    ]);
    eq(files.get(path.join(W, 'born.js')).backupFileName, null, 'created stays created');
  }

  // --- both forms in one log (snapshot-era prefix, delta-era suffix) ---
  {
    const files = await filesOf([
      userMsg('hi'),
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: {
        'old.js': backup('1111111111111111@v1', 1, W),
      } } },
      delta('newer.js', backup('2222222222222222@v1', 1, W)),
    ]);
    eq(files.size, 2, 'snapshot and delta records coexist');
    eq(files.get(path.join(W, 'old.js')).backupFileName, '1111111111111111@v1', 'snapshot entry kept');
    eq(files.get(path.join(W, 'newer.js')).backupFileName, '2222222222222222@v1', 'delta entry kept');
  }

  // --- realParentDir absent -> resolve the relative path against session cwd ---
  {
    const files = await filesOf([
      userMsg('hi'), emptySnap,
      delta('nodir.js', { backupFileName: null, version: 1 }),
    ]);
    eq(files.size, 1, 'delta without realParentDir falls back to cwd');
    assert(files.has(path.join(W, 'nodir.js')), 'cwd-resolved path');
  }

  // --- malformed deltas are ignored, not fatal ---
  {
    const files = await filesOf([
      userMsg('hi'), emptySnap,
      { type: 'file-history-delta' },                              // no backup
      { type: 'file-history-delta', backup: null },                // null backup
      { type: 'file-history-delta', trackingPath: 'x.js', backup: {} }, // no dir, no name
      delta('ok.js', backup(null, 1, W)),
    ]);
    assert(files.has(path.join(W, 'ok.js')), 'valid delta still read after malformed ones');
    assert(!files.has(path.join(W, 'x.js')) || files.get(path.join(W, 'x.js')).backupFileName === null,
      'dirless delta resolved via cwd or skipped, never crashes');
  }

  // --- a delta-only session still gets a title (no snapshot to lean on) ---
  {
    const parsed = await lib.parseSession(session([
      userMsg('fix the parser'), emptySnap, delta('t.js', backup(null, 1, W)),
    ]));
    eq(parsed.title, 'fix the parser', 'title from first prompt in a delta-only session');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`OK: ${checks} file-history-delta checks passed`);
})();
