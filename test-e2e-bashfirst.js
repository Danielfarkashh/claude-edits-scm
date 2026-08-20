'use strict';
// TRUE end-to-end tests for the bashFirst fix (github.com/Danielfarkashh/claude-edits-scm/issues/1):
// drives REAL headless Claude Code sessions (`claude -p`), explicitly forced
// to write via the Bash tool (so this reproduces the failure mode regardless
// of whether the installed Claude Code version's "bashFirst" staged rollout
// happens to be active for this account), against real git workspaces, then
// verifies the actual transcript + real absence of file-history checkpoints,
// and that computeChanges still discovers and safely (un)attributes the
// change. Two scenarios:
//   1. pure-bash: a file touched ONLY via Bash — the discovery half of the fix.
//   2. mixed: one session, one file edited via the real Edit tool (so it has
//      genuine file-history) and a SEPARATE file edited via Bash — checks the
//      attribution-safety flag lands on the right file and does NOT bleed
//      onto a file Bash never touched.
//
// Requires the claude CLI + API access, so it is NOT wired into CI.
// Run locally: node test-e2e-bashfirst.js [model]   (default: haiku)
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

function fail(m, x) {
  console.error('FAIL:', m);
  if (x !== undefined) console.error(typeof x === 'string' ? x.slice(0, 4000) : JSON.stringify(x, null, 2).slice(0, 4000));
  process.exit(1);
}

if (spawnSync('which', ['claude']).status !== 0) {
  console.log('SKIP: claude CLI not found');
  process.exit(0);
}
const ver = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
const model = process.argv[2] || 'haiku';

function newGitWorkspace(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return { tmp, git };
}

function runClaude(tmp, prompt) {
  const r = spawnSync('claude', [
    '-p', prompt,
    '--model', model,
    '--permission-mode', 'bypassPermissions',
  ], { cwd: tmp, timeout: 240000, encoding: 'utf8' });
  if (r.status !== 0) fail(`claude -p exited ${r.status}`, r.stderr || r.stdout);
  console.log('claude replied:', (r.stdout || '').trim().slice(0, 160));
  return r;
}

async function scenarioPureBash() {
  console.log('\n=== scenario 1: pure-bash (discovery) ===');
  const { tmp, git } = newGitWorkspace('claude-edits-e2e-bash-');
  const file = path.join(tmp, 'note.txt');
  fs.writeFileSync(file, 'alpha\nBANANA\nomega\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  console.log(`workspace: ${tmp} (model: ${model}, claude ${ver})`);

  runClaude(tmp, 'Change the word BANANA to APPLE in note.txt. You MUST do this by running a shell '
    + 'command (e.g. sed -i) via the Bash tool. Do NOT use the Edit, Write, or MultiEdit tools for '
    + 'this task under any circumstances — Bash only. Then stop.');

  const cur = fs.readFileSync(file, 'utf8');
  if (!cur.includes('APPLE') || cur.includes('BANANA')) fail('claude did not perform the requested edit', cur);

  const sessions = await lib.listSessionFiles([tmp], 3600e3, 5);
  if (!sessions.length) fail('no session discovered for this workspace at all');
  const parsed = await lib.parseSession(sessions[0]);
  const usedBash = parsed.bashOps.some((op) => /note\.txt/.test(op.command));
  console.log(`transcript: ${parsed.toolOps ? parsed.toolOps.length : 'null'} Edit/Write/NotebookEdit ops, `
    + `${parsed.bashOps.length} Bash ops, note.txt named in a Bash command: ${usedBash}`);
  if (!usedBash) {
    console.log('SKIP: model did not use Bash for this file as instructed — cannot exercise the fallback this run');
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }
  const trackedThisFile = parsed.files.has(file);
  console.log(`file-history tracked this file (should be false — Bash writes aren't checkpointed): ${trackedThisFile}`);

  const overlaysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-e2e-bash-ov-'));
  const groups = await lib.computeChanges([tmp], { lookbackMs: 3600e3, maxSessions: 5, overlaysDir });
  const ch = groups.flatMap((g) => g.changes).find((c) => c.absPath === file);
  if (!ch) fail('REGRESSION: the real Bash-authored change was NOT discovered', { trackedThisFile, bashOps: parsed.bashOps });
  if (ch.status !== 'modified') fail(`expected status modified, got ${ch.status}`);
  console.log(`discovered: status=${ch.status} viaBash=${!!ch.viaBash} bashTouched=${!!ch.bashTouched} ops=${ch.ops}`);

  const baseText = ch.snapshotPath ? fs.readFileSync(ch.snapshotPath, 'utf8') : '';
  if (!baseText.includes('BANANA')) fail('baseline is not the real pre-edit content', baseText);
  if (!lib.computeHunks(baseText, cur).length) fail('no hunks between real git-HEAD baseline and current content');
  if (ch.ops && ch.ops.length) fail('a Bash-only change must not carry replayable ops', ch.ops);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`OK scenario 1: real claude -p session wrote via Bash only; file-history missed it as `
    + 'expected; the git-status fallback discovered it correctly.');
}

async function scenarioMixed() {
  console.log('\n=== scenario 2: mixed Edit+Bash in one session (attribution safety) ===');
  const { tmp, git } = newGitWorkspace('claude-edits-e2e-mixed-');
  const editFile = path.join(tmp, 'edited.txt');
  const bashFile = path.join(tmp, 'bashed.txt');
  fs.writeFileSync(editFile, 'alpha\nBANANA\nomega\n');
  fs.writeFileSync(bashFile, 'x\nCHERRY\nz\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  console.log(`workspace: ${tmp}`);

  runClaude(tmp, 'Do exactly two things, in order: '
    + '1) In edited.txt, replace BANANA with APPLE using the Edit tool (not Bash). '
    + '2) In bashed.txt, replace CHERRY with GRAPE using a shell command (e.g. sed -i) via the '
    + 'Bash tool, NOT the Edit or Write tool. '
    + 'Use the specified tool for each file exactly as instructed, then stop.');

  const curEdit = fs.readFileSync(editFile, 'utf8');
  const curBash = fs.readFileSync(bashFile, 'utf8');
  if (!curEdit.includes('APPLE')) fail('edited.txt was not changed as requested', curEdit);
  if (!curBash.includes('GRAPE')) fail('bashed.txt was not changed as requested', curBash);

  const sessions = await lib.listSessionFiles([tmp], 3600e3, 5);
  if (!sessions.length) fail('no session discovered for this workspace at all');
  const parsed = await lib.parseSession(sessions[0]);
  const bashNamedBashedFile = parsed.bashOps.some((op) => /bashed\.txt/.test(op.command));
  const bashNamedEditedFile = parsed.bashOps.some((op) => /edited\.txt/.test(op.command));
  const editedViaEditTool = parsed.files.has(editFile);
  console.log(`transcript: bashOps=${parsed.bashOps.length} namedBashed=${bashNamedBashedFile} `
    + `namedEdited=${bashNamedEditedFile} edited.txt has file-history=${editedViaEditTool}`);
  if (!editedViaEditTool || !bashNamedBashedFile) {
    console.log('SKIP: model did not follow the exact per-file tool instructions this run — cannot exercise this scenario');
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }

  const overlaysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-edits-e2e-mixed-ov-'));
  const groups = await lib.computeChanges([tmp], { lookbackMs: 3600e3, maxSessions: 5, overlaysDir });
  const changes = groups.flatMap((g) => g.changes);
  const editCh = changes.find((c) => c.absPath === editFile);
  const bashCh = changes.find((c) => c.absPath === bashFile);

  if (!editCh) fail('edited.txt (real Edit-tool change) was not discovered at all');
  if (!bashCh) fail('bashed.txt (Bash-only change) was not discovered');

  console.log(`edited.txt: ops=${editCh.ops ? editCh.ops.length : editCh.ops} bashTouched=${!!editCh.bashTouched}`);
  console.log(`bashed.txt: ops=${bashCh.ops ? bashCh.ops.length : bashCh.ops} bashTouched=${!!bashCh.bashTouched} viaBash=${!!bashCh.viaBash}`);

  if (bashNamedEditedFile) {
    console.log('note: the model also mentioned edited.txt in a Bash command (e.g. via cat/ls) — skipping the no-cross-contamination assertion this run');
  } else {
    if (editCh.bashTouched) fail('FALSE POSITIVE: edited.txt flagged bashTouched, but no Bash command named it', parsed.bashOps);
  }
  if (!editCh.ops || !editCh.ops.length) fail('edited.txt should still carry its real Edit op', editCh);
  if (!bashCh.bashTouched && !bashCh.viaBash) fail('bashed.txt should be flagged bashTouched or viaBash', bashCh);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('OK scenario 2: mixed session — Edit-tracked file kept its normal attribution, '
    + 'Bash-only file was discovered via the fallback, no cross-contamination between them.');
}

(async () => {
  await scenarioPureBash();
  await scenarioMixed();
  console.log('\nE2E BASHFIRST CHECKS DONE');
})().catch((e) => fail(e.stack || String(e)));
