'use strict';
// Property tests for the diff/hunk engine. Run: node test-hunks.js [iterations]
const lib = require('./lib');

let seed = 42;
function rnd() { // deterministic LCG so failures are reproducible
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function ri(n) { return Math.floor(rnd() * n); }

const ALPHA = ['a', 'b', 'c', 'd', 'e', ''];
function randLines(max) {
  return Array.from({ length: ri(max) }, () => ALPHA[ri(ALPHA.length)]);
}
function mutate(lines) {
  const out = lines.slice();
  const edits = 1 + ri(6);
  for (let i = 0; i < edits; i++) {
    const op = ri(3);
    const pos = ri(out.length + 1);
    if (op === 0) out.splice(pos, 0, ALPHA[ri(ALPHA.length)]); // insert
    else if (op === 1 && out.length) out.splice(ri(out.length), 1); // delete
    else if (out.length) out[ri(out.length)] = ALPHA[ri(ALPHA.length)]; // replace
  }
  return out;
}

function fail(msg, base, cur, extra) {
  console.error('FAIL:', msg);
  console.error('base:', JSON.stringify(base));
  console.error('cur :', JSON.stringify(cur));
  if (extra !== undefined) console.error('info:', JSON.stringify(extra));
  process.exit(1);
}

function checkPair(baseArr, curArr) {
  // canonicalize to the production representation: lines are always split('\n')
  // of some text, so the array is never empty ('' splits to ['']).
  const baseText = baseArr.join('\n');
  const curText = curArr.join('\n');
  const baseLines = baseText.split('\n');
  const curLines = curText.split('\n');
  const hunks = lib.computeHunks(baseText, curText);

  // hunks must be sorted, non-overlapping, non-empty
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (h.baseCount === 0 && h.curCount === 0) fail('empty hunk', baseLines, curLines, h);
    if (h.baseStart < 0 || h.curStart < 0) fail('negative index', baseLines, curLines, h);
    if (h.baseStart + h.baseCount > baseLines.length) fail('base overflow', baseLines, curLines, h);
    if (h.curStart + h.curCount > curLines.length) fail('cur overflow', baseLines, curLines, h);
    if (i > 0) {
      const p = hunks[i - 1];
      if (h.baseStart < p.baseStart + p.baseCount || h.curStart < p.curStart + p.curCount) {
        fail('hunks overlap/unsorted', baseLines, curLines, { p, h });
      }
      // strictly separated by at least one unchanged line
      if (h.baseStart === p.baseStart + p.baseCount && h.curStart === p.curStart + p.curCount) {
        fail('adjacent hunks not merged', baseLines, curLines, { p, h });
      }
    }
  }

  // identical <=> zero hunks
  if ((baseText === curText) !== (hunks.length === 0)) fail('hunk count vs equality', baseLines, curLines, hunks);

  // applying ALL hunks to base (reverse order keeps indices valid) reconstructs cur
  let nb = baseLines;
  for (let i = hunks.length - 1; i >= 0; i--) nb = lib.applyHunkToBase(nb, curLines, hunks[i]);
  if (nb.join('\n') !== curText) fail('apply-all != cur', baseLines, curLines, hunks);

  // reverting ALL hunks in cur (reverse order) reconstructs base
  let nc = curLines;
  for (let i = hunks.length - 1; i >= 0; i--) nc = lib.revertHunkInCur(baseLines, nc, hunks[i]);
  if (nc.join('\n') !== baseText) fail('revert-all != base', baseLines, curLines, hunks);

  // keeping ONE hunk shrinks the outstanding edit distance by at least that
  // hunk's size (re-diffing may re-align/merge neighbors, so exact hunk counts
  // are not canonical), and repeated keeps converge to a clean diff
  const dist = (hs) => hs.reduce((n, x) => n + x.baseCount + x.curCount, 0);
  if (hunks.length > 1) {
    const pick = ri(hunks.length);
    const h = hunks[pick];
    const kept = lib.applyHunkToBase(baseLines, curLines, h);
    const after = lib.computeHunks(kept.join('\n'), curText);
    if (dist(after) > dist(hunks) - (h.baseCount + h.curCount)) {
      fail('keep-one did not shrink edit distance enough', baseLines, curLines, { pick, hunks, after });
    }
    let b = kept;
    let guard = dist(hunks) + 5;
    while (guard-- > 0) {
      const hs = lib.computeHunks(b.join('\n'), curText);
      if (!hs.length) break;
      b = lib.applyHunkToBase(b, curLines, hs[0]);
    }
    if (guard <= 0) fail('keep loop did not converge', baseLines, curLines, hunks);
  }
}

// --- edge cases ---
const edge = [
  [[], []],
  [[''], ['']],
  [[], ['x']],
  [['x'], []],
  [['x'], ['x']],
  [['x'], ['y']],
  [['x', ''], ['x']],            // trailing newline removed
  [['x'], ['x', '']],            // trailing newline added
  [['a', 'b', 'c', ''], ['a', 'X', 'c', '']],
  [['a', 'a', 'a'], ['a', 'a']],  // repeated lines
  [['a', 'b', 'a', 'b'], ['b', 'a', 'b', 'a']],
  [['', '', ''], ['']],
];
for (const [b, c] of edge) { checkPair(b, c); checkPair(c, b); }

// --- huge-rewrite fallback: must stay fast/bounded and degrade to ONE hunk ---
{
  const big1 = Array.from({ length: 25000 }, (_, i) => `line-${i}-v1`);
  const big2 = Array.from({ length: 25000 }, (_, i) => `line-${i}-v2`);
  const t0 = Date.now();
  const hs = lib.computeHunks(big1.join('\n'), big2.join('\n'));
  const ms = Date.now() - t0;
  if (ms > 2000) fail(`huge rewrite took ${ms}ms (must be bounded)`, ['<25k lines>'], ['<25k lines>']);
  if (hs.length !== 1) fail(`huge rewrite: expected 1 coarse hunk, got ${hs.length}`, [], [], hs);
  const nb = lib.applyHunkToBase(big1, big2, hs[0]);
  if (nb.join('\n') !== big2.join('\n')) fail('coarse hunk apply != cur', [], []);
  // dissimilar-but-small also falls back via the D cap without erroring
  const d1 = Array.from({ length: 1500 }, (_, i) => `a${i}`);
  const d2 = Array.from({ length: 1500 }, (_, i) => `b${i}`);
  const hs2 = lib.computeHunks(d1.join('\n'), d2.join('\n'));
  let nb2 = d1;
  for (let i = hs2.length - 1; i >= 0; i--) nb2 = lib.applyHunkToBase(nb2, d2, hs2[i]);
  if (nb2.join('\n') !== d2.join('\n')) fail('D-cap fallback apply != cur', [], []);
  console.log(`huge-rewrite fallback OK (25k-line rewrite diffed in ${ms}ms, 1 coarse hunk)`);
}

// --- randomized ---
const iters = parseInt(process.argv[2] || '5000', 10);
for (let i = 0; i < iters; i++) {
  const base = randLines(40);
  checkPair(base, mutate(base));
  const unrelated = randLines(30);
  checkPair(base, unrelated); // completely different contents
}

console.log(`OK: ${edge.length * 2} edge cases + ${iters * 2} randomized checks passed`);
