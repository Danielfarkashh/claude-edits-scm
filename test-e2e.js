'use strict';
// TRUE end-to-end test: drives a REAL headless Claude Code session
// (`claude -p`) in a temp workspace, then verifies the whole pipeline —
// session discovery, snapshot resolution, transcript op capture, byte-exact
// replay, and Claude-vs-user attribution — against whatever data format the
// installed Claude Code version actually writes.
//
// Requires the claude CLI + API access, so it is NOT wired into CI.
// Run locally: node test-e2e.js [model]   (default: haiku)
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

function fail(m, x) {
  console.error('FAIL:', m);
  if (x !== undefined) console.error(typeof x === 'string' ? x.slice(0, 2000) : JSON.stringify(x, null, 2).slice(0, 2000));
  process.exit(1);
}

if (spawnSync('which', ['claude']).status !== 0) {
  console.log('SKIP: claude CLI not found');
  process.exit(0);
}

const model = process.argv[2] || 'haiku';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-e2e-'));
const file = path.join(tmp, 'note.txt');
fs.writeFileSync(file, 'alpha\nBANANA\nomega\n');
console.log(`workspace: ${tmp} (model: ${model})`);

const r = spawnSync('claude', [
  '-p', 'Open note.txt and replace the word BANANA with APPLE using the Edit tool. Change nothing else, then stop.',
  '--model', model,
  '--permission-mode', 'acceptEdits',
], { cwd: tmp, timeout: 240000, encoding: 'utf8' });
if (r.status !== 0) fail(`claude -p exited ${r.status}`, r.stderr || r.stdout);
console.log('claude replied:', (r.stdout || '').trim().slice(0, 160));

const cur = fs.readFileSync(file, 'utf8');
if (!cur.includes('APPLE') || cur.includes('BANANA')) fail('claude did not perform the requested edit', cur);

(async () => {
  const groups = await lib.computeChanges([tmp], { lookbackMs: 3600e3, maxSessions: 5 });
  const ch = groups.flatMap((g) => g.changes).find((c) => c.absPath === file);
  if (!ch) fail('pipeline did not detect the change', groups);
  if (ch.status !== 'modified') fail(`expected status modified, got ${ch.status}`);
  if (!ch.ops || !ch.ops.length) fail('no tool ops captured from the transcript', ch);
  const snap = ch.snapshotPath ? fs.readFileSync(ch.snapshotPath, 'utf8') : '';
  if (!snap.includes('BANANA')) fail('snapshot is not the pre-edit content', snap);

  const rep = lib.replayClaudeOps(snap, ch.ops);
  if (!rep.ok) fail('transcript replay failed', ch.ops);
  if (rep.text !== cur) fail('replayed content differs from disk', { replayed: rep.text, disk: cur });

  let marked = lib.attributeHunks(snap, cur, lib.computeHunks(snap, cur), rep.text, snap);
  if (!marked.length || !marked.every((h) => h.claude)) fail("claude's hunk not attributed to claude", marked);

  // a user edit made afterwards must NOT be attributed to Claude
  fs.appendFileSync(file, 'user was here\n');
  const cur2 = fs.readFileSync(file, 'utf8');
  marked = lib.attributeHunks(snap, cur2, lib.computeHunks(snap, cur2), rep.text, snap);
  if (marked.filter((h) => h.claude).length !== 1) fail('claude hunk count wrong after user edit', marked);
  if (marked.filter((h) => !h.claude).length !== 1) fail('user hunk wrongly attributed', marked);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('E2E OK: real claude -p edit detected, replayed byte-exact, and attributed correctly (user edit excluded)');
})().catch((e) => fail(e.stack || String(e)));
