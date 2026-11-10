'use strict';
// Bash-authored-changes tests (github.com/Danielfarkashh/claude-edits-scm/issues/1):
// Claude Code 2.1.221+'s "bashFirst" prompting steers auto/bypassPermissions
// sessions to write files via Bash, which Claude Code's own checkpoints never
// see. Two things under test:
//   1. extractBashWriteTargets / bashWriteCandidates — the heuristic that
//      finds candidate paths from a bash command string + session transcript.
//   2. computeChanges — end-to-end discovery of bash-only changes via a real
//      git repo standing in for Claude Code's own file-history, plus the
//      attribution-safety flag (bashTouched) on files that DO have
//      file-history but were also named by a Bash command in the same session.
// Part 2 writes into real ~/.claude (uniquely-named temp session/workspace,
// cleaned up in a finally) since PROJECTS_DIR/FILE_HISTORY_DIR are fixed by
// lib.js — the same approach test-e2e.js already relies on for real data.
// Usage: node test-bashfirst.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function setEq(actual, expected, msg) {
  eq(JSON.stringify([...actual].sort()), JSON.stringify([...expected].sort()), msg);
}

async function main() {
  // --- Part 1: extractBashWriteTargets (pure function, no I/O) -----------
  setEq(lib.extractBashWriteTargets('echo hi > out.txt'), ['out.txt'], '> redirect');
  setEq(lib.extractBashWriteTargets('echo hi >> out.txt'), ['out.txt'], '>> redirect');
  setEq(lib.extractBashWriteTargets('cat > "quoted path.txt" <<EOF\nx\nEOF'), ['quoted path.txt'], 'quoted target with an internal space');
  setEq(lib.extractBashWriteTargets("sed -i 's/a/b/' file.js"), ['file.js'], 'sed -i single target');
  setEq(lib.extractBashWriteTargets("sed -i.bak 's/a/b/' file.js"), ['file.js'], 'sed -i.bak suffix form');
  setEq(lib.extractBashWriteTargets("sed -n -i.bak -e 's/a/b/' file.js"), ['file.js'], 'sed with flags before AND after -i');
  setEq(lib.extractBashWriteTargets('tee out.log <<< hi'), ['out.log'], 'tee target');
  setEq(lib.extractBashWriteTargets('tee -a out.log <<< hi'), ['out.log'], 'tee -a target');
  setEq(lib.extractBashWriteTargets('cmd 2>&1 | tee /dev/null'), [], 'fd-dup (2>&1) and /dev/null both excluded');
  setEq(lib.extractBashWriteTargets('ls -la'), [], 'read-only command yields nothing');
  setEq(lib.extractBashWriteTargets(''), [], 'empty command yields nothing');
  setEq(lib.extractBashWriteTargets(null), [], 'non-string command yields nothing');
  console.log(`OK: extractBashWriteTargets (${checks} checks so far)`);

  // --- Part 2: bashWriteCandidates via parseSession, self-contained ------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-bash-'));
    let seq = 0;
    const session = (lines) => {
      const sessionId = `bash${String(++seq).padStart(4, '0')}-1111-2222-3333-444444444444`;
      const jsonlPath = path.join(dir, `${sessionId}.jsonl`);
      fs.writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return { sessionId, jsonlPath, mtimeMs: fs.statSync(jsonlPath).mtimeMs };
    };
    const W = process.platform === 'win32' ? 'C:\\w' : '/w';
    const userMsg = (text) => ({ type: 'user', cwd: W, message: { role: 'user', content: text } });
    const bashUse = (id, command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const bashResult = (id, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError }] } });

    {
      const parsed = await lib.parseSession(session([
        userMsg('do stuff'),
        bashUse('b1', "sed -i 's/a/b/' rel/file.js"),
        bashResult('b1', false),
      ]));
      eq(parsed.bashOps.length, 1, 'one bash op captured');
      const cands = lib.bashWriteCandidates(parsed);
      assert(cands.has(path.resolve(W, 'rel/file.js')), 'relative candidate resolved against session cwd');
    }
    {
      // errored bash calls must not contribute candidates — Claude never actually wrote the file
      const parsed = await lib.parseSession(session([
        userMsg('do stuff'),
        bashUse('b1', 'echo hi > should-not-count.txt'),
        bashResult('b1', true),
      ]));
      eq(lib.bashWriteCandidates(parsed).size, 0, 'errored bash command contributes no candidates');
    }
    {
      const abs = process.platform === 'win32' ? 'C:\\w\\abs.txt' : '/w/abs.txt';
      const parsed = await lib.parseSession(session([
        userMsg('do stuff'),
        bashUse('b1', `echo hi > ${abs}`),
        bashResult('b1', false),
      ]));
      assert(lib.bashWriteCandidates(parsed).has(abs), 'absolute path target left as-is');
    }
    {
      const parsed = await lib.parseSession(session([
        userMsg('do stuff'),
        bashUse('b1', "cd sub/repo && sed -i 's/a/b/' x.js && cd ../other && echo hi > y.txt"),
        bashResult('b1', false),
        bashUse('b2', 'echo hi > ~/home-file.txt; echo hi > "$OUT/skipped.txt"'),
        bashResult('b2', false),
      ]));
      const cands = lib.bashWriteCandidates(parsed);
      assert(cands.has(path.resolve(W, 'sub/repo/x.js')), 'relative target after `cd` resolves against the cd target');
      assert(cands.has(path.resolve(W, 'sub/other/y.txt')), 'a second relative `cd` chains from the first');
      assert(cands.has(path.join(os.homedir(), 'home-file.txt')), '~ expands to the home directory');
      assert(![...cands].some((c) => c.includes('skipped')), 'unexpandable $VAR targets are dropped');
    }
    {
      const T = Date.parse('2026-11-10T12:00:00.000Z');
      const at = (ms) => new Date(T + ms).toISOString();
      const parsed = await lib.parseSession(session([
        userMsg('do stuff'),
        { ...bashUse('t1', 'python3 - <<EOF\nopen("f","w")\nEOF'), timestamp: at(0) },
        { ...bashResult('t1', false), timestamp: at(3000) },
        { ...bashUse('t2', 'npm run build'), timestamp: at(10000) },
        { ...bashResult('t2', false), timestamp: at(10000 + 5 * 60e3) },
        { ...bashUse('t3', 'still running'), timestamp: at(20 * 60e3) },
      ]));
      const w = lib.bashWindows(parsed);
      eq(w.length, 1, 'only the short, finished Bash call yields a window');
      eq(JSON.stringify(w[0]), JSON.stringify([T - 1000, T + 5000]), 'window spans tool_use..tool_result plus slack');
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`OK: bashWriteCandidates (${checks} checks so far)`);
  }

  // --- Part 3: computeChanges end-to-end, against a real git repo --------
  let hasGit = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
  if (!hasGit) {
    console.log('SKIP: git not available — skipping computeChanges bash-discovery checks');
    console.log(`ALL BASH-FIRST CHECKS PASSED (${checks} checks)`);
    return;
  }

  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-bashrepo-'));
  const overlaysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-bashoverlays-'));
  const sessionId = 'bashe2e1-1111-2222-3333-444444444444';
  const projDir = path.join(lib.PROJECTS_DIR, lib.sanitizeProjectDir(W));
  const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);
  const cleanup = () => {
    for (const p of [W, overlaysDir, projDir, path.join(lib.FILE_HISTORY_DIR, sessionId)]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  };

  try {
    const git = (...args) => execFileSync('git', args, { cwd: W, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(W, 'tracked.txt'), 'line1\nline2\nline3\n');
    fs.writeFileSync(path.join(W, 'mixed.txt'), 'alpha\nbeta\ngamma\n');
    for (const f of ['py-written.txt', 'user-edit.txt', 'during-build.txt']) fs.writeFileSync(path.join(W, f), 'orig\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    // tracked.txt: modified purely via a shell command Claude Code never checkpointed
    fs.writeFileSync(path.join(W, 'tracked.txt'), 'line1\nCHANGED\nline3\n');
    // brand-new file, never checkpointed, not yet git-added either
    fs.writeFileSync(path.join(W, 'new-from-bash.txt'), 'brand new content\n');
    // mixed.txt: has a real file-history entry (simulating an Edit tool call)
    // but is ALSO named by a Bash command in the same session
    const mixedAbs = path.join(W, 'mixed.txt');
    const mixedHash = lib.hashPath(mixedAbs);
    fs.mkdirSync(path.join(lib.FILE_HISTORY_DIR, sessionId), { recursive: true });
    fs.writeFileSync(path.join(lib.FILE_HISTORY_DIR, sessionId, `${mixedHash}@v1`), 'alpha\nbeta\ngamma\n');
    fs.writeFileSync(mixedAbs, 'alpha\nBETA-EDITED\ngamma-bash-appended\n');

    // Timing discovery: no command names these files, only their mtimes
    // tie them (or not) to a Bash call.
    const T = Date.now() - 3600e3;
    const at = (ms) => new Date(T + ms).toISOString();
    const touch = (f, ms) => {
      fs.writeFileSync(path.join(W, f), 'changed\n');
      fs.utimesSync(path.join(W, f), (T + ms) / 1000, (T + ms) / 1000);
    };
    touch('py-written.txt', 1500); // inside the 3s python call
    touch('user-edit.txt', 30e3); // between calls: the user's own edit
    touch('during-build.txt', 200e3); // inside a 5-minute build: too long to trust

    fs.mkdirSync(projDir, { recursive: true });
    const lines = [
      { type: 'user', cwd: W, message: { role: 'user', content: 'fix things' } },
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: {
        'mixed.txt': { backupFileName: `${mixedHash}@v1`, version: 1, backupTime: '2026-08-20T00:00:00.000Z', realParentDir: W },
      } } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: mixedAbs, old_string: 'beta', new_string: 'BETA-EDITED' } },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: "sed -i 's/line2/CHANGED/' tracked.txt" } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: false }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: "cat > new-from-bash.txt <<'EOF'\nbrand new content\nEOF" } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b2', is_error: false }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'b3', name: 'Bash', input: { command: 'echo more >> mixed.txt' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b3', is_error: false }] } },
      { type: 'assistant', timestamp: at(0), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'b4', name: 'Bash', input: { command: "python3 - <<'EOF'\nfrom pathlib import Path\nPath('py-written.txt').write_text('changed')\nEOF" } },
      ] } },
      { type: 'user', timestamp: at(3000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b4', is_error: false }] } },
      { type: 'assistant', timestamp: at(100e3), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'b5', name: 'Bash', input: { command: 'npm run build' } },
      ] } },
      { type: 'user', timestamp: at(100e3 + 5 * 60e3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b5', is_error: false }] } },
    ];
    fs.writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const groups = await lib.computeChanges([W], { lookbackMs: 48 * 3600e3, maxSessions: 6, overlaysDir });
    const byPath = new Map(groups.flatMap((g) => g.changes).map((c) => [c.absPath, c]));

    const trackedCh = byPath.get(path.join(W, 'tracked.txt'));
    assert(trackedCh, 'bash-only modified file discovered via git status (was previously invisible)');
    if (trackedCh) {
      eq(trackedCh.status, 'modified', 'discovered file status is modified');
      eq(trackedCh.ops, null, 'no replay possible for a bash-discovered file');
      assert(trackedCh.bashTouched, 'bash-discovered file flagged bashTouched');
      assert(trackedCh.viaBash, 'bash-discovered file flagged viaBash');
      assert(trackedCh.snapshotPath && fs.existsSync(trackedCh.snapshotPath), 'materialized git HEAD blob exists on disk');
      eq(fs.readFileSync(trackedCh.snapshotPath, 'utf8'), 'line1\nline2\nline3\n', 'materialized baseline matches git HEAD content');
    }

    const newCh = byPath.get(path.join(W, 'new-from-bash.txt'));
    assert(newCh, 'bash-created untracked file discovered');
    if (newCh) {
      eq(newCh.status, 'created', 'untracked bash-written file shows as created');
      eq(newCh.snapshotPath, null, 'created file has no baseline');
    }

    const mixedCh = byPath.get(mixedAbs);
    assert(mixedCh, 'file-history-tracked file still discovered via the normal path');
    if (mixedCh) {
      assert(mixedCh.bashTouched, 'file-history-tracked file ALSO named by a Bash command is flagged bashTouched (attribution-safety fix)');
      assert(Array.isArray(mixedCh.ops) && mixedCh.ops.length === 1, 'mixed.txt still carries its real Edit op unaffected');
    }

    const pyCh = byPath.get(path.join(W, 'py-written.txt'));
    assert(pyCh && pyCh.viaBash, 'file written during a Bash call is discovered by timing, with no path in the command');
    assert(!byPath.has(path.join(W, 'user-edit.txt')), 'dirty file modified outside every Bash call is left to the user');
    assert(!byPath.has(path.join(W, 'during-build.txt')), 'a call longer than the window cap cannot claim files');

    console.log(`OK: computeChanges bash discovery + attribution-safety (${checks} checks so far)`);
  } finally {
    cleanup();
  }

  console.log(`ALL BASH-FIRST CHECKS PASSED (${checks} checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
