'use strict';
// Path-spelling tests (github.com/Danielfarkashh/claude-edits-scm/issues/2#issuecomment):
// VS Code hands the extension a lowercase drive letter (c:\...) while Claude
// Code records C:\... . A file reached through both spellings, its
// file-history entry and the git-dirty scan that timing discovery runs from the
// workspace root, must still be listed once. Windows only: elsewhere the two
// spellings are different files.
// Usage: node test-pathcase.js
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

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP: path-spelling checks need win32');
    return;
  }
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-case-'));
  const vsCodeRoot = W[0].toLowerCase() + W.slice(1);
  const overlaysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-caseov-'));
  const sessionId = 'pathcase-1111-2222-3333-444444444444';
  const projDir = path.join(lib.PROJECTS_DIR, lib.sanitizeProjectDir(W));
  const histDir = path.join(lib.FILE_HISTORY_DIR, sessionId);
  try {
    const git = (...args) => execFileSync('git', args, { cwd: W, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(W, 'a.txt'), 'before\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const abs = path.join(W, 'a.txt');
    const hash = lib.hashPath(abs);
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, `${hash}@v1`), 'before\n');
    const T = Date.now() - 600e3;
    fs.writeFileSync(abs, 'after\n');
    fs.utimesSync(abs, (T + 1000) / 1000, (T + 1000) / 1000);

    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), [
      { type: 'user', cwd: W, message: { role: 'user', content: 'edit a' } },
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: {
        'a.txt': { backupFileName: `${hash}@v1`, version: 1, realParentDir: W },
      } } },
      { type: 'assistant', timestamp: new Date(T).toISOString(), message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'python -c "open(\'a.txt\',\'w\').write(\'after\')"' } },
      ] } },
      { type: 'user', timestamp: new Date(T + 2000).toISOString(), message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'b1', is_error: false },
      ] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    const groups = await lib.computeChanges([vsCodeRoot], { lookbackMs: 3600e3, maxSessions: 6, overlaysDir });
    const rows = groups.flatMap((g) => g.changes).filter((c) => path.basename(c.absPath) === 'a.txt');
    assert(rows.length === 1, `a.txt listed once, got ${rows.length}: ${rows.map((r) => `${r.absPath}${r.viaBash ? ' (viaBash)' : ''}`).join(', ')}`);
    assert(rows[0] && rows[0].bashTouched, 'the Bash-touched file keeps its bashTouched flag');
  } finally {
    for (const p of [W, overlaysDir, projDir, histDir]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
  console.log(`OK: ${checks} path-spelling checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
