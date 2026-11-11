'use strict';
// Clear-on-commit tests (github.com/Danielfarkashh/claude-edits-scm/issues/3):
// computeChanges({markCommitted}) flags a change as committed only when git
// holds exactly that content (tracked and clean). Anything uncommitted,
// staged-only, untracked or ignored must stay listed.
// Writes into real ~/.claude (uniquely-named temp session, cleaned up in a
// finally), same as test-bashfirst.js.
// Usage: node test-commit.js
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
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch {
    console.log('SKIP: git not available');
    return;
  }
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-commit-')));
  const overlaysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-commitov-'));
  const sessionId = 'commit01-1111-2222-3333-444444444444';
  const projDir = path.join(lib.PROJECTS_DIR, lib.sanitizeProjectDir(W));
  const histDir = path.join(lib.FILE_HISTORY_DIR, sessionId);
  try {
    const git = (...args) => execFileSync('git', args, { cwd: W, stdio: 'ignore' });
    const write = (f, c) => fs.writeFileSync(path.join(W, f), c);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    const edited = ['committed.txt', 'uncommitted.txt', 'staged.txt', 'with space.txt', 'ignored.txt'];
    for (const f of edited) write(f, 'before\n');
    write('.gitignore', 'ignored.txt\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    fs.mkdirSync(histDir, { recursive: true });
    const tracked = {};
    for (const f of edited) {
      const hash = lib.hashPath(path.join(W, f));
      fs.writeFileSync(path.join(histDir, `${hash}@v1`), 'before\n');
      tracked[f] = { backupFileName: `${hash}@v1`, version: 1, realParentDir: W };
      write(f, 'after Claude\n');
    }
    for (const f of ['created-committed.txt', 'created-untracked.txt']) {
      tracked[f] = { backupFileName: null, version: 1, realParentDir: W };
      write(f, 'new from Claude\n');
    }

    git('add', 'committed.txt', 'created-committed.txt');
    git('commit', '-q', '-m', 'take Claude work');
    git('add', 'staged.txt');

    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), [
      { type: 'user', cwd: W, message: { role: 'user', content: 'change things' } },
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: tracked } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    const opts = { lookbackMs: 3600e3, maxSessions: 6, overlaysDir };
    const flags = async (o) => new Map((await lib.computeChanges([W], o))
      .flatMap((g) => g.changes).map((c) => [path.basename(c.absPath), !!c.committed]));

    const on = await flags({ ...opts, markCommitted: true });
    assert(on.size === 7, `all 7 changes are listed (got ${[...on.keys()]})`);
    assert(on.get('committed.txt'), 'a committed modification is flagged');
    assert(on.get('created-committed.txt'), 'a committed new file is flagged');
    assert(!on.get('uncommitted.txt'), 'an uncommitted modification is not flagged');
    assert(!on.get('staged.txt'), 'a staged but uncommitted modification is not flagged');
    assert(!on.get('with space.txt'), 'a path git status quotes is still seen as dirty');
    assert(!on.get('ignored.txt'), 'a gitignored file is clean to git status but not committed');
    assert(!on.get('created-untracked.txt'), 'an untracked new file is not flagged');

    const off = await flags(opts);
    assert(![...off.values()].some(Boolean), 'nothing is flagged unless markCommitted is set');
  } finally {
    for (const p of [W, overlaysDir, projDir, histDir]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
  console.log(`OK: ${checks} clear-on-commit checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
