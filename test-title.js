'use strict';
// Session-title tests: Claude Code's own ai-title record (re-appended as it
// refines the topic, so the LAST one wins, read from a bounded tail near EOF)
// plus the first-prompt/slug/id fallback chain. Self-contained — writes
// synthetic logs to a temp dir, no real ~/.claude data needed.
// Usage: node test-title.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-title-'));
let seq = 0;

// Lines are either objects (stringified) or raw strings (malformed/oversized ones).
function jsonl(lines) {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
}
function rawSession(content) { // line-ending/EOF shapes jsonl() cannot express
  const sessionId = `sess${String(++seq).padStart(4, '0')}-1111-2222-3333-444444444444`;
  const jsonlPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, content);
  return { sessionId, jsonlPath, mtimeMs: fs.statSync(jsonlPath).mtimeMs };
}
function session(lines) {
  return rawSession(jsonl(lines));
}

const snapshot = (rel, info) => ({
  type: 'file-history-snapshot',
  snapshot: { trackedFileBackups: { [rel]: info } },
});
const SNAP = snapshot('a.txt', { backupFileName: 'deadbeef0000@v1', version: 1, realParentDir: '/w' });
const userMsg = (text) => ({ type: 'user', cwd: '/w', message: { role: 'user', content: text } });
const aiTitle = (t) => ({ type: 'ai-title', aiTitle: t, sessionId: 'ignored' });
// One valid record of exactly `bytes` bytes, containing no '"ai-title"' substring.
function padLine(bytes) {
  const head = '{"type":"assistant","pad":"';
  const tail = '"}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
}

(async () => {
  // --- the last ai-title wins over earlier ones, and beats the first prompt ---
  {
    const p = await lib.parseSession(session([
      userMsg('Switch the session label to the generated title'),
      aiTitle('First guess at the topic'),
      SNAP,
      aiTitle('Second guess at the topic'),
      aiTitle('Document title generation process'),
    ]));
    eq(p.title, 'Document title generation process', 'last ai-title wins');
  }

  // --- a user rename (custom-title) beats ai-title, even when Claude keeps
  // re-appending its own title after the rename (the real log shape) ---
  {
    const p = await lib.parseSession(session([
      userMsg('Some prompt'),
      aiTitle('Lab portal project hosting'),
      SNAP,
      { type: 'custom-title', sessionId: 'ignored', customTitle: 'First rename' },
      aiTitle('Lab portal project hosting'),
      padLine(64 * 1024),
      { type: 'custom-title', customTitle: 'Idan Onboarding', sessionId: 'ignored' },
      aiTitle('Lab portal project hosting'),
      { type: 'custom-title', customTitle: '   ' },
      { type: 'custom-title', customTitle: 7 },
    ]));
    eq(p.title, 'Idan Onboarding', 'last non-blank custom-title wins over ai-title');
  }

  // --- a rename appended to an already-parsed log shows up on the next parse ---
  {
    const lines = [userMsg('Rename refresh'), SNAP, aiTitle('Weird generated name')];
    const s = session(lines);
    eq((await lib.parseSession(s)).title, 'Weird generated name', 'ai-title before the rename');
    fs.appendFileSync(s.jsonlPath, jsonl([{ type: 'custom-title', customTitle: 'Renamed', sessionId: 'x' }]));
    eq((await lib.parseSession({ ...s, mtimeMs: s.mtimeMs + 1 })).title, 'Renamed', 'rename is picked up after the log grows');
  }

  // --- no ai-title yet: the first real prompt is still used (previous behaviour) ---
  {
    const p = await lib.parseSession(session([
      { type: 'assistant', slug: 'dynamic-doodling-stream', message: {} },
      userMsg('Fix the flaky snapshot test'),
      SNAP,
    ]));
    eq(p.title, 'Fix the flaky snapshot test', 'falls back to the first prompt');
  }

  // --- prompt fallback keeps its 60-char cap and tag stripping ---
  {
    const long = `Refactor ${'the parser '.repeat(20)}please`;
    const p = await lib.parseSession(session([userMsg(`<ide_opened>x</ide_opened> ${long}`), SNAP]));
    eq(p.title, `x ${long}`.slice(0, 60), 'prompt fallback is capped at 60 chars');
  }

  // --- slash-command-only session with no ai-title: slug is next ---
  {
    const p = await lib.parseSession(session([
      userMsg('/clear'),
      { type: 'assistant', cwd: '/w', slug: 'dynamic-doodling-stream', message: {} },
      SNAP,
    ]));
    eq(p.title, 'dynamic-doodling-stream', 'falls back to the log slug');
  }

  // --- nothing usable: the short session id ---
  {
    const s = session([{ type: 'system', cwd: '/w', subtype: 'boot' }, SNAP]);
    const p = await lib.parseSession(s);
    eq(p.title, `session ${s.sessionId.slice(0, 8)}`, 'falls back to the short session id');
  }

  // --- multi-MB shape: window opens mid-line; the partial line must not throw,
  // the last title in the window wins, and late snapshots are still tracked ---
  {
    const p = await lib.parseSession(session([
      userMsg('Review the multi-MB shape'),
      aiTitle('Stale title'),
      padLine(300 * 1024),
      aiTitle('Refined title'),
      aiTitle('Final title near EOF'),
      snapshot('sub/b.txt', { backupFileName: null, version: 1 }),
      SNAP,
    ]));
    eq(p.title, 'Final title near EOF', 'last title wins across a multi-MB log');
    assert(p.files.has(path.join('/w', 'a.txt')), 'snapshot after the header is still tracked');
    assert(p.files.has(path.resolve('/w', 'sub/b.txt')), 'realParentDir-less snapshot resolves against cwd');
  }

  // --- a title is NOT looked for in a bounded tail: one turn's tool output can put
  // megabytes between the last title and EOF (1.24 MB seen in a real log), and the
  // label must not fall back to the prompt while that turn runs ---
  {
    const p = await lib.parseSession(session([
      userMsg('Title sits far from EOF'),
      aiTitle('Still the session title'),
      padLine(1024 * 1024), // one big tool result, longer than any tail window
      SNAP,
    ]));
    eq(p.title, 'Still the session title', 'title 1 MB from EOF is still used');
  }

  // --- titles and the delta record form coexist (both pass the same prefilter) ---
  {
    const p = await lib.parseSession(session([
      userMsg('Delta-form session'),
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: {} } },
      padLine(64 * 1024),
      { type: 'file-history-delta', trackingPath: 'c.txt', snapshotMessageId: 'm1', backup: { backupFileName: 'cafe12340000@v1', version: 1, realParentDir: '/w' } },
      aiTitle('Delta session title'),
    ]));
    eq(p.title, 'Delta session title', 'title is found in a delta-form log');
    assert(p.files.has(path.join('/w', 'c.txt')), 'delta after the header is still tracked');
  }

  // --- '"ai-title"' nested in another record is not a title ---
  {
    const p = await lib.parseSession(session([
      userMsg('Nested lookalike'),
      SNAP,
      { type: 'assistant', message: {}, payload: { type: 'ai-title', aiTitle: 'not a session title' } },
    ]));
    eq(p.title, 'Nested lookalike', 'nested ai-title object is ignored');
  }

  // --- malformed and non-string ai-title records are skipped, earlier good one kept ---
  {
    const p = await lib.parseSession(session([
      userMsg('Robustness'),
      SNAP,
      aiTitle('Good title'),
      '{"type":"ai-title","aiTitle":"unterminated',
      { type: 'ai-title', aiTitle: 42 },
      { type: 'ai-title' },
      aiTitle('   '),
      aiTitle(''),
    ]));
    eq(p.title, 'Good title', 'malformed/blank/non-string ai-titles are skipped');
  }

  // --- the tail read sits inside the mtime-keyed parse cache ---
  {
    const s = session([userMsg('Cache check'), SNAP, aiTitle('Cached title')]);
    const first = await lib.parseSession(s);
    const second = await lib.parseSession(s);
    assert(first === second, 'same mtime returns the cached parse');
    fs.writeFileSync(s.jsonlPath, jsonl([userMsg('Cache check'), SNAP, aiTitle('Fresh title')]));
    const third = await lib.parseSession({ ...s, mtimeMs: s.mtimeMs + 1 });
    eq(third.title, 'Fresh title', 'a newer mtime re-reads the title');
  }

  // --- line-ending and end-of-file shapes ---
  {
    const lines = [userMsg('Line endings'), SNAP, aiTitle('Windows line endings')].map((l) => JSON.stringify(l));
    const crlf = rawSession(`${lines.join('\r\n')}\r\n`);
    eq((await lib.parseSession(crlf)).title, 'Windows line endings', 'CRLF line endings are tolerated');

    const noEol = rawSession(lines.join('\n')); // no trailing newline
    eq((await lib.parseSession(noEol)).title, 'Windows line endings', 'last line without a trailing newline is read');

    const empty = rawSession('');
    eq((await lib.parseSession(empty)).title, `session ${empty.sessionId.slice(0, 8)}`, 'empty log falls back to the id');

    const missing = { sessionId: 'ffffffff-0000-0000-0000-000000000000', jsonlPath: path.join(dir, 'missing.jsonl'), mtimeMs: 1 };
    eq((await lib.parseSession(missing)).title, 'session ffffffff', 'unreadable log falls back to the id');
  }

  console.log(`OK: ${checks} session-title checks passed`);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
