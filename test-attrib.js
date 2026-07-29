'use strict';
// Attribution engine tests: replay of transcript tool ops + Claude-vs-user
// hunk marking. Uses unique line tags so diff alignment is unambiguous and
// assertions can be exact. Run: node test-attrib.js [iterations]
const lib = require('./lib');

let seed = 7;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

function fail(msg, extra) {
  console.error('FAIL:', msg);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2).slice(0, 4000));
  process.exit(1);
}

// --- applyStringEdits / replayClaudeOps units ---
{
  let r = lib.applyStringEdits('a b a', [{ old_string: 'a', new_string: 'x' }]);
  if (!r.ok || r.text !== 'x b a') fail('single replace', r);
  r = lib.applyStringEdits('a b a', [{ old_string: 'a', new_string: 'x', replace_all: true }]);
  if (!r.ok || r.text !== 'x b x') fail('replace_all', r);
  r = lib.applyStringEdits('abc', [{ old_string: 'zz', new_string: 'x' }]);
  if (r.ok) fail('missing old_string must fail');
  r = lib.replayClaudeOps('', [{ name: 'Write', input: { content: 'hello\nworld' } }]);
  if (!r.ok || r.text !== 'hello\nworld') fail('write replay', r);
  r = lib.replayClaudeOps('one\ntwo', [
    { name: 'Edit', input: { old_string: 'two', new_string: 'TWO' } },
    { name: 'MultiEdit', input: { edits: [{ old_string: 'one', new_string: 'ONE' }] } },
  ]);
  if (!r.ok || r.text !== 'ONE\nTWO') fail('edit+multiedit replay', r);
  r = lib.replayClaudeOps('x', [{ name: 'NotebookEdit', input: {} }]);
  if (r.ok) fail('notebook replay must be unsupported');
  console.log('unit tests OK');
}

// --- attribution scenario generator ---
// snapshot: unique tags L0..Ln. Claude replaces / inserts C-tags via ops.
// User then replaces / inserts U-tags in lines untouched by Claude.
function makeScenario(nLines) {
  const snap = Array.from({ length: nLines }, (_, i) => `L${i}`);
  // Claude edits: pick disjoint single-line replacements + one insertion
  const claudeIdx = new Set();
  const nClaude = 1 + ri(3);
  while (claudeIdx.size < nClaude) claudeIdx.add(1 + ri(nLines - 2));
  const ops = [];
  for (const i of claudeIdx) {
    ops.push({ name: 'Edit', input: { old_string: `L${i}`, new_string: `C${i}a\nC${i}b` } });
  }
  const rep = lib.replayClaudeOps(snap.join('\n'), ops);
  if (!rep.ok) fail('scenario replay failed', { ops });
  const claudeFinal = rep.text;

  // user edits: replace untouched L-tags that are ≥2 lines away from any C-region
  const finalLines = claudeFinal.split('\n');
  const userTargets = [];
  for (let i = 0; i < finalLines.length; i++) {
    const isL = /^L\d+$/.test(finalLines[i]);
    const nearC = [finalLines[i - 1], finalLines[i + 1], finalLines[i - 2], finalLines[i + 2]]
      .some((l) => l && l.startsWith('C'));
    if (isL && !nearC) userTargets.push(i);
  }
  const curLines = finalLines.slice();
  const nUser = Math.min(userTargets.length, 1 + ri(2));
  const chosen = [];
  for (let k = 0; k < nUser; k++) {
    const t = userTargets[ri(userTargets.length)];
    if (chosen.includes(t)) continue;
    chosen.push(t);
    curLines[t] = `U${t}`;
  }
  return { snapText: snap.join('\n'), claudeFinal, curText: curLines.join('\n'), ops, hadUser: chosen.length > 0 };
}

function checkMarks(effText, curText, claudeFinal, snapText) {
  const hunks = lib.computeHunks(effText, curText);
  const marked = lib.attributeHunks(effText, curText, hunks, claudeFinal, snapText);
  for (const h of marked) {
    const curSlice = curText.split('\n').slice(h.curStart, h.curStart + h.curCount);
    const hasC = curSlice.some((l) => l.startsWith('C'));
    const hasU = curSlice.some((l) => l.startsWith('U'));
    const delOnly = h.curCount === 0;
    if (hasC && !h.claude) fail('Claude-authored hunk not marked', { h, curSlice });
    if (hasU && !hasC && !delOnly && h.claude) fail('user-only hunk wrongly marked as Claude', { h, curSlice });
  }
  return marked;
}

// --- regression: manual edit AFTER keeping a Claude change stays the user's ---
{
  const snap = ['a', 'b', 'c', 'd', 'e'].join('\n');
  const rep = lib.replayClaudeOps(snap, [{ name: 'Edit', input: { old_string: 'c', new_string: 'C1\nC2' } }]);
  if (!rep.ok) fail('regression replay failed');
  // user keeps Claude's change (effBase == claudeFinal), then edits that spot
  const cur = rep.text.replace('C2', 'USER');
  const marked = lib.attributeHunks(rep.text, cur, lib.computeHunks(rep.text, cur), rep.text, snap);
  if (marked.some((h) => h.claude)) fail('edit after keep wrongly attributed to Claude', marked);
}
{
  // partial keep: CA kept then user-edited; CB still outstanding
  const snap = Array.from({ length: 10 }, (_, i) => `x${i}`).join('\n');
  const rep = lib.replayClaudeOps(snap, [
    { name: 'Edit', input: { old_string: 'x2', new_string: 'CA' } },
    { name: 'Edit', input: { old_string: 'x7', new_string: 'CB' } },
  ]);
  if (!rep.ok) fail('partial-keep replay failed');
  const effBase = snap.replace('x2', 'CA'); // only CA kept
  const cur = rep.text.replace('CA', 'USER-EDIT');
  const marked = lib.attributeHunks(effBase, cur, lib.computeHunks(effBase, cur), rep.text, snap);
  for (const h of marked) {
    const slice = cur.split('\n').slice(h.curStart, h.curStart + h.curCount).join('\n');
    if (slice.includes('USER-EDIT') && h.claude) fail('user edit in kept region marked as Claude', marked);
    if (slice.includes('CB') && !h.claude) fail('outstanding Claude hunk lost its mark', marked);
  }
  console.log('kept-region regression OK');
}

// --- keeping your OWN lines must not poison attribution ---
{
  const snap = 'h\np\nq';
  const rep = lib.replayClaudeOps(snap, [{ name: 'Edit', input: { old_string: 'p', new_string: 'CLAUDE' } }]);
  if (!rep.ok) fail('own-lines replay failed');
  // user added junk AND kept everything (overlay = claude content + own junk)
  const overlay = 'h\nJUNK1\nJUNK2\nCLAUDE\nq';
  // then edits again near their own kept junk
  const cur = 'h\nJUNK1\nJUNK3\nJUNK2\nCLAUDE\nq';
  const marked = lib.attributeHunks(overlay, cur, lib.computeHunks(overlay, cur), rep.text, snap);
  if (marked.some((h) => h.claude)) fail('post-keep edit near own kept lines marked as Claude', marked);
  // ...while a genuinely unkept Claude change still marks: baseline without CLAUDE
  const overlay2 = 'h\np\nJUNK1\nq'; // user kept junk but NOT claude's p->CLAUDE edit
  const cur2 = 'h\nCLAUDE\nJUNK1\nq';
  const marked2 = lib.attributeHunks(overlay2, cur2, lib.computeHunks(overlay2, cur2), rep.text, snap);
  if (!marked2.some((h) => h.claude)) fail('outstanding Claude change lost after own-lines filter', marked2);
  // whole-file-authored session (empty snapshot, e.g. a created file): after
  // keep-all, user junk anywhere in the file must stay unmarked
  const rep3 = lib.replayClaudeOps('', [{ name: 'Write', input: { content: 'one\ntwo\nthree' } }]);
  const cur3 = 'one\ntwo\nUSERJUNK\nthree';
  const marked3 = lib.attributeHunks(rep3.text, cur3, lib.computeHunks(rep3.text, cur3), rep3.text, '');
  if (marked3.some((h) => h.claude)) fail('user junk after keep-all marked in created file', marked3);
  console.log('own-kept-lines regression OK');
}

// --- content semantics: novel user lines never mark, pending Claude content always does ---
{
  const snap = 'a\nb\nc\nd';
  const cf = 'a\nBBB\nc\nd'; // claude changed b -> BBB
  // nothing kept yet: claude's BBB on disk plus the user's junk right around it
  const cur = 'a\nUSER-UP\nBBB\nUSER-DOWN\nc\nd';
  const marked = lib.attributeHunks(snap, cur, lib.computeHunks(snap, cur), cf, snap);
  for (const h of marked) {
    const txt = cur.split('\n').slice(h.curStart, h.curStart + h.curCount).join('|');
    if (txt.includes('BBB') && !h.claude) fail('pending Claude line lost its mark', marked);
    if (!txt.includes('BBB') && h.claude && h.curCount > 0) fail('user-only lines wrongly marked', marked);
  }
  // claude DELETION pending: cf and disk lack c, baseline still has it
  const cfDel = 'a\nb\nd';
  const mDel = lib.attributeHunks(snap, cfDel, lib.computeHunks(snap, cfDel), cfDel, snap);
  if (!mDel.length || !mDel.every((h) => h.claude)) fail('pending Claude deletion not marked', mDel);
  // user deleting their OWN kept junk is not Claude's
  const effJ = 'a\nJUNKX\nb\nc\nd';
  const curJ = 'a\nb\nc\nd';
  const mJ = lib.attributeHunks(effJ, curJ, lib.computeHunks(effJ, curJ), effJ, snap);
  if (mJ.some((h) => h.claude)) fail('deleting own kept junk marked as Claude', mJ);
  console.log('content-semantics unit OK');
}

// --- path scoping globs ---
{
  if (!lib.matchAnyGlob('/tmp/claude-1000/scratch/x.txt', ['/tmp/claude-*/**'])) fail('scratchpad glob should match');
  if (!lib.matchAnyGlob('/home/u/.claude/projects/p/memory/m.md', ['**/.claude/**'])) fail('memory glob should match');
  if (!lib.matchAnyGlob('/home/u/repo/.claude/settings.json', ['**/.claude/**'])) fail('project .claude glob should match');
  if (lib.matchAnyGlob('/home/u/code/a.js', ['/tmp/claude-*/**', '**/.claude/**'])) fail('normal file wrongly matched');
  if (lib.matchAnyGlob('/tmp/claudette/x', ['/tmp/claude-*/**'])) fail('near-miss dir wrongly matched');
  console.log('glob tests OK');
}

// --- anchored replay: out-of-band change mid-session must not disable attribution ---
{
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attrib-anchor-'));
  const A = 'a\nb\nc'; // pre-session snapshot
  const A2 = 'a\nB2\nc'; // after an out-of-band change (git/manual)
  const post1 = 'a\nCLAUDE1\nc'; // after Claude's 1st edit (made on A2)
  const final = 'a\nCLAUDE1\nCLAUDE2';
  const v1 = path.join(tmp, 'h@v1'); fs.writeFileSync(v1, A);
  const v2 = path.join(tmp, 'h@v2'); fs.writeFileSync(v2, A2);
  const v3 = path.join(tmp, 'h@v3'); fs.writeFileSync(v3, post1);
  const ch = {
    snapshotPath: v1,
    backupFiles: [v1, v2, v3],
    ops: [
      { name: 'Edit', input: { old_string: 'B2', new_string: 'CLAUDE1' } }, // fails from A
      { name: 'Edit', input: { old_string: 'c', new_string: 'CLAUDE2' } },
    ],
  };
  lib.claudeFinalFor(ch).then((cf) => {
    if (cf !== final) fail('anchored replay did not recover claudeFinal', { cf, final });
    // user edit AFTER Claude's last edit stays the user's
    const cur = final + '\nUSER';
    const marked = lib.attributeHunks(A, cur, lib.computeHunks(A, cur), cf, A);
    for (const h of marked) {
      const slice = cur.split('\n').slice(h.curStart, h.curStart + h.curCount).join('\n');
      if (slice === 'USER' && h.claude) fail('post-Claude user edit marked as Claude (anchored path)', marked);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('anchored replay regression OK');
  }).catch((e) => fail(e.stack));
}

const iters = parseInt(process.argv[2] || '2000', 10);
for (let it = 0; it < iters; it++) {
  const sc = makeScenario(12 + ri(30));
  // no overlay yet: effBase == snapshot
  const marked = checkMarks(sc.snapText, sc.curText, sc.claudeFinal);

  // keep each Claude hunk into the baseline one at a time; user hunks must
  // stay unmarked and remaining Claude hunks marked throughout
  let effLines = sc.snapText.split('\n');
  let guard = 50;
  for (;;) {
    if (guard-- <= 0) fail('keep loop did not converge');
    const effText = effLines.join('\n');
    const m = checkMarks(effText, sc.curText, sc.claudeFinal);
    const claudeHunks = m.filter((h) => h.claude);
    if (!claudeHunks.length) break;
    effLines = lib.applyHunkToBase(effLines, sc.curText.split('\n'), claudeHunks[0]);
  }
  // after keeping all Claude hunks, remaining diff must be user-only
  const rest = lib.computeHunks(effLines.join('\n'), sc.curText);
  for (const h of rest) {
    const slice = sc.curText.split('\n').slice(h.curStart, h.curStart + h.curCount);
    if (slice.some((l) => l.startsWith('C'))) fail('C content left after keeping all Claude hunks', { h, slice });
  }
}
console.log(`OK: ${iters} attribution scenarios passed`);

// --- real-data smoke: replay success rate over actual sessions (informational) ---
(async () => {
  const root = process.argv[3] || process.env.HOME;
  const groups = await lib.computeChanges([root], { lookbackMs: 48 * 3600e3, maxSessions: 6 });
  let withOps = 0;
  let okCount = 0;
  const fs = require('fs');
  for (const g of groups) {
    for (const c of g.changes) {
      if (!c.ops || !c.ops.length) continue;
      withOps++;
      const snap = c.snapshotPath ? fs.readFileSync(c.snapshotPath, 'utf8') : '';
      if (lib.replayClaudeOps(snap, c.ops).ok) okCount++;
    }
  }
  console.log(`real-data replay: ${okCount}/${withOps} changes replayed cleanly`);
})();
