'use strict';
// Data layer: reads Claude Code's own checkpoint data. No vscode dependency (testable with plain node).
//
// Format (undocumented, verified against Claude Code 2.1.220 and 2.1.24x):
//   ~/.claude/projects/<cwd with [^a-zA-Z0-9] -> '-'>/<session-uuid>.jsonl
//     lines of {"type":"file-history-snapshot","snapshot":{"trackedFileBackups":{
//        "<relative path>": {"backupFileName":"<sha256(abs path)[0..16]>@v<N>"|null,
//                             "version":N,"backupTime":iso,"realParentDir":"<abs dir>"}}}}
//     backupFileName === null  => file was created by Claude (no prior content)
//     Newer builds emit ONE snapshot with an empty trackedFileBackups, then a
//     delta per edit instead of rewriting the whole map:
//       {"type":"file-history-delta","trackingPath":"<relative|absolute path>",
//        "snapshotMessageId":...,"backup":{<same shape as a trackedFileBackups value>}}
//     Both forms can appear; parseSession folds them into the same map.
//     lines of {"type":"ai-title","aiTitle":"<session title>","sessionId":...} — the
//       human-readable name `claude --resume` shows. Re-appended as Claude refines it
//       (136 of them in an 8.2 MB log), so the LAST one wins; absent in young sessions.
//     lines of {"type":"custom-title","customTitle":"<name>","sessionId":...} — written
//       when the user renames the session, re-appended like ai-title; beats ai-title.
//   ~/.claude/file-history/<session-uuid>/<hash>@v<N>  = file content BEFORE the Nth edit;
//     v1 (lowest N present) is the pre-session baseline.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');

function sanitizeProjectDir(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

// Same scheme Claude Code uses for backup file names.
function hashPath(absPath) {
  return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

// Windows paths reach us with inconsistent casing/separators (VS Code URIs,
// JSONL realParentDir); canonicalize before comparing or hashing. Identity on
// POSIX (absolute paths are already normal, case-sensitive fs).
function canonPath(p) {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

// Overlays are keyed per FILE (not per session): "accepted content" is a
// property of the file — once the user keeps content, every session's entry
// for that file compares against it and they hide/show consistently.
function overlayPathFor(overlaysDir, absPath) {
  return path.join(overlaysDir, hashPath(canonPath(absPath)));
}

// ---------------------------------------------------------------------------
// Line diff (Myers O(ND)) -> hunks. A hunk means: baseLines[baseStart ..
// baseStart+baseCount) corresponds to curLines[curStart .. curStart+curCount).
// ---------------------------------------------------------------------------

// Returns null when the edit distance exceeds maxD (caller falls back to a
// coarse single hunk) — this bounds trace memory to maxD * (2(n+m)+1) * 4 bytes
// and keeps the extension host safe on huge rewrites.
function myersOps(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((_, j) => ({ t: 'ins', aIdx: 0, bIdx: j }));
  if (!m) return a.map((_, i) => ({ t: 'del', aIdx: i, bIdx: 0 }));
  const max = n + m;
  const cap = Math.min(max, maxD == null ? max : maxD);
  const off = max;
  const trace = [];
  const v = new Int32Array(2 * max + 1);
  let dFinal = -1;
  for (let d = 0; d <= cap && dFinal < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { dFinal = d; break; }
    }
  }
  if (dFinal < 0) return null; // edit distance > cap
  const opsRev = [];
  let x = n;
  let y = m;
  for (let d = dFinal; d > 0; d--) {
    const vp = trace[d]; // v-state after depth d-1
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vp[off + k - 1] < vp[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vp[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; } // walk the snake back
    if (prevK === k + 1) { y--; opsRev.push({ t: 'ins', aIdx: x, bIdx: y }); }
    else { x--; opsRev.push({ t: 'del', aIdx: x, bIdx: y }); }
    x = prevX;
    y = prevY;
  }
  return opsRev.reverse();
}

// -> [{baseStart, baseCount, curStart, curCount}] sorted by position.
// Very large or very dissimilar regions degrade gracefully to ONE coarse hunk
// spanning the whole changed region (still semantically valid for keep/revert,
// just less granular) instead of letting Myers go quadratic.
const DIFF_LINE_LIMIT = 2000;
const DIFF_D_LIMIT = 1000;

function computeHunks(baseText, curText) {
  if (baseText === curText) return [];
  const a = baseText.split('\n');
  const b = curText.split('\n');
  let pre = 0;
  const minLen = Math.min(a.length, b.length);
  while (pre < minLen && a[pre] === b[pre]) pre++;
  let endA = a.length;
  let endB = b.length;
  while (endA > pre && endB > pre && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = Math.max(endA - pre, endB - pre) > DIFF_LINE_LIMIT
    ? null
    : myersOps(a.slice(pre, endA), b.slice(pre, endB), DIFF_D_LIMIT);
  if (ops === null) {
    return [{ baseStart: pre, baseCount: endA - pre, curStart: pre, curCount: endB - pre }];
  }
  const hunks = [];
  let h = null;
  for (const op of ops) {
    const isDel = op.t === 'del';
    if (h && op.aIdx === h.aEnd && op.bIdx === h.bEnd) {
      if (isDel) h.aEnd++; else h.bEnd++;
    } else {
      if (h) hunks.push(h);
      h = {
        aStart: op.aIdx,
        aEnd: op.aIdx + (isDel ? 1 : 0),
        bStart: op.bIdx,
        bEnd: op.bIdx + (isDel ? 0 : 1),
      };
    }
  }
  if (h) hunks.push(h);
  return hunks.map((x) => ({
    baseStart: x.aStart + pre,
    baseCount: x.aEnd - x.aStart,
    curStart: x.bStart + pre,
    curCount: x.bEnd - x.bStart,
  }));
}

// "Keep": absorb one hunk of the current content into the baseline.
function applyHunkToBase(baseLines, curLines, h) {
  const nb = baseLines.slice();
  nb.splice(h.baseStart, h.baseCount, ...curLines.slice(h.curStart, h.curStart + h.curCount));
  return nb;
}

// "Revert": put the baseline content of one hunk back into the current lines.
function revertHunkInCur(baseLines, curLines, h) {
  const nc = curLines.slice();
  nc.splice(h.curStart, h.curCount, ...baseLines.slice(h.baseStart, h.baseStart + h.baseCount));
  return nc;
}

// ---------------------------------------------------------------------------
// Claude-vs-user attribution. Replaying the session's Edit/Write tool calls
// over the pre-session snapshot reconstructs "what Claude left behind"; the
// regions it differs from the snapshot are Claude-authored. An outstanding
// hunk (vs the accepted baseline) is Claude's iff its snapshot-space range
// overlaps one of those regions. Replay is best-effort: any mismatch (user
// edits interleaved mid-session, unsupported tools) returns ok=false and the
// caller falls back to treating every hunk as Claude's.
// ---------------------------------------------------------------------------

function applyStringEdits(text, edits) {
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return { ok: false };
    if (e.old_string === '') {
      if (text !== '') return { ok: false };
      text = e.new_string;
      continue;
    }
    if (e.replace_all) {
      if (!text.includes(e.old_string)) return { ok: false };
      text = text.split(e.old_string).join(e.new_string);
    } else {
      const i = text.indexOf(e.old_string);
      if (i < 0) return { ok: false };
      text = text.slice(0, i) + e.new_string + text.slice(i + e.old_string.length);
    }
  }
  return { ok: true, text };
}

function replayClaudeOps(baseText, ops) {
  let text = baseText;
  for (const op of ops) {
    const inp = op.input || {};
    if (op.name === 'Write') {
      if (typeof inp.content !== 'string') return { ok: false };
      text = inp.content;
    } else if (op.name === 'Edit') {
      const r = applyStringEdits(text, [inp]);
      if (!r.ok) return { ok: false };
      text = r.text;
    } else if (op.name === 'MultiEdit') {
      const r = applyStringEdits(text, Array.isArray(inp.edits) ? inp.edits : []);
      if (!r.ok) return { ok: false };
      text = r.text;
    } else {
      return { ok: false }; // NotebookEdit and friends: no reliable text replay
    }
  }
  return { ok: true, text };
}

// hunks are diff(effBaseText -> curText); returns them with a .claude flag.
// CONTENT-based attribution — positions and diff alignment proved unreliable
// (whole-file-authored sessions make coordinate filters vacuous, and Myers can
// align user lines against unrelated content). A hunk is Claude's iff:
//   - it INTRODUCES a line that exists in Claude's replayed output but is not
//     yet in the accepted baseline (pending Claude content), or
//   - it DELETES a line that Claude's output also lacks but the pre-session
//     snapshot had (pending Claude deletion of original content).
// Everything else — novel user lines, edits to accepted content, deletions of
// the user's own kept lines — stays the user's, wherever it sits in the file.
// Blank lines are ignored as signals (they appear everywhere).
function attributeHunks(effBaseText, curText, hunks, claudeFinalText, snapshotText) {
  const norm = (l) => l.trim();
  const cfSet = new Set(claudeFinalText.split('\n').map(norm));
  const effSet = new Set(effBaseText.split('\n').map(norm));
  const snapSet = new Set((snapshotText ?? '').split('\n').map(norm));
  const effLines = effBaseText.split('\n');
  const curLines = curText.split('\n');
  return hunks.map((h) => {
    let claude = false;
    for (let i = h.curStart; !claude && i < h.curStart + h.curCount; i++) {
      const s = norm(curLines[i] ?? '');
      if (s && cfSet.has(s) && !effSet.has(s)) claude = true; // Claude content not yet accepted
    }
    for (let i = h.baseStart; !claude && i < h.baseStart + h.baseCount; i++) {
      const s = norm(effLines[i] ?? '');
      if (s && !cfSet.has(s) && snapSet.has(s)) claude = true; // Claude's pending deletion of original content
    }
    return { ...h, claude };
  });
}

// ---------------------------------------------------------------------------
// Bash-authored changes. Claude Code only checkpoints Edit/Write/NotebookEdit
// calls (~/.claude/file-history/) — a file touched solely through Bash (sed,
// heredocs, redirects) has no snapshot/backup at all, so it's invisible to
// the tracking above, and a file touched by BOTH Edit/Write and Bash has its
// Bash-authored hunks silently misattributed to the user once replay
// "succeeds" without knowing they happened. Two independent, best-effort
// signals close both gaps without parsing shell semantics precisely:
//   1. extractBashWriteTargets: a heuristic regex scan of the command string
//      for the write patterns Claude Code's own "bashFirst" prompting names
//      (redirects, heredocs via their leading redirect, tee, sed -i).
//   2. cross-checking the extracted path against `git status`: it must
//      actually be dirty right now for a candidate to be trusted.
// False negatives are safe (status quo: untracked, same as before this
// existed). False positives are bounded by signal #2 — the odds of a bash
// command coincidentally naming a path that is ALSO independently git-dirty
// for an unrelated reason are low, and even then the failure mode is just
// "shown as Claude's, unattributed" (never "hidden"), which is the same
// fallback every other unreplayable case already uses.
// ---------------------------------------------------------------------------

function extractBashWriteTargets(command) {
  if (typeof command !== 'string' || !command) return [];
  const targets = new Set();
  const unquote = (s) => s.replace(/^['"]|['"]$/g, '');
  // > file / >> file / N> file (not fd-dup forms like 2>&1 — '&' is excluded
  // from the bare-token charset, so those fail to match a target at all).
  // Quoted alternatives come first so a quoted target may contain spaces.
  for (const m of command.matchAll(/(?:^|[\s;&|(])(?:\d*>>?|&>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s'";&|<>()]+))/g)) {
    const t = m[1] ?? m[2] ?? m[3];
    if (t) targets.add(t);
  }
  // tee [-a] file — first non-flag token after the command name.
  for (const m of command.matchAll(/\btee\b\s+((?:-{1,2}\S+\s+)*)(\S+)/g)) {
    targets.add(unquote(m[2]));
  }
  // sed -i[.suffix] 'expr' file [file...] — skip flags, skip the first
  // non-flag token (the expression), the rest are targets.
  for (const m of command.matchAll(/\bsed\b\s+(?:-\S+\s+)*-i(?:\.\S+)?\s+(.+)/g)) {
    let skippedExpr = false;
    for (const tok of m[1].trim().split(/\s+/).filter(Boolean)) {
      if (tok.startsWith('-')) continue;
      if (!skippedExpr) { skippedExpr = true; continue; }
      targets.add(unquote(tok));
    }
  }
  return [...targets].filter((t) => t && !t.startsWith('/dev/'));
}

// -> Set<absPath>, resolved against the session's cwd.
function bashWriteCandidates(parsed) {
  const out = new Set();
  for (const op of parsed.bashOps || []) {
    if (parsed.errIds.has(op.id)) continue;
    for (const t of extractBashWriteTargets(op.command)) {
      const abs = path.isAbsolute(t) ? t : (parsed.cwd ? path.resolve(parsed.cwd, t) : null);
      if (abs) out.add(abs);
    }
  }
  return out;
}

function gitRun(args, cwd, encoding) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, encoding: encoding || 'utf8' }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function gitRepoRoot(dir) {
  const out = await gitRun(['rev-parse', '--show-toplevel'], dir);
  return out === null ? null : out.trim();
}

// -> Map<absPath, 'modified'|'untracked'> for the repo's current working tree.
async function gitDirtyPaths(top) {
  const map = new Map();
  const out = await gitRun(['status', '--porcelain=v1', '-uall', '--no-renames'], top);
  if (out === null) return map;
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rel = line.slice(3);
    map.set(path.resolve(top, rel), code.includes('?') ? 'untracked' : 'modified');
  }
  return map;
}

// Writes the file's HEAD blob to a cache file and returns its path (like a
// Claude Code @v1 backup, but sourced from git instead) — null if there is
// no HEAD blob to read (new-but-staged file, detached/empty repo, etc).
async function materializeGitHead(top, absPath, cacheDir) {
  const rel = path.relative(top, absPath).split(path.sep).join('/');
  const buf = await gitRun(['show', `HEAD:${rel}`], top, 'buffer');
  if (buf === null) return null;
  await fsp.mkdir(cacheDir, { recursive: true }).catch(() => {});
  const dest = path.join(cacheDir, hashPath(canonPath(absPath)) + '.head');
  await fsp.writeFile(dest, buf);
  return dest;
}

// Minimal glob support for path scoping: '**' spans path separators, '*'
// stays within one segment. Case-insensitive on win32; matches on
// forward-slashed absolute paths.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

function matchAnyGlob(absPath, globs) {
  if (!globs || !globs.length) return false;
  const p = absPath.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(String(g).replace(/\\/g, '/')).test(p));
}

function underAny(p, roots) {
  const cp = canonPath(p);
  return roots.some((r) => {
    const cr = canonPath(r);
    return cp === cr || cp.startsWith(cr.endsWith(path.sep) ? cr : cr + path.sep);
  });
}

// Sessions are keyed by the cwd they were LAUNCHED from, which is often not
// the workspace root (e.g. `claude` run from ~ editing repo files, or from a
// subdirectory). Scan the workspace's own project dir, every ancestor's, and
// every subdirectory's; computeChanges filters files by workspace root anyway.
// Which ~/.claude/projects entries can hold sessions relevant to these roots?
// Case-insensitive on win32: VS Code reports lowercase drive letters (c:\...)
// while Claude Code records cwd with Node's casing (C:\...), so sanitized
// names differ in case between the two sources.
function matchProjectDirs(projectDirs, workspaceRoots) {
  const win = process.platform === 'win32';
  const norm = (s) => (win ? s.toLowerCase() : s);
  const byNorm = new Map();
  for (const e of projectDirs) if (!byNorm.has(norm(e))) byNorm.set(norm(e), e);
  const dirs = new Set();
  for (const r of workspaceRoots) {
    const own = norm(sanitizeProjectDir(r));
    let p = r;
    for (;;) { // workspace root + all ancestors
      const hit = byNorm.get(norm(sanitizeProjectDir(p)));
      if (hit) dirs.add(hit);
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
    }
    for (const e of projectDirs) if (norm(e).startsWith(own + '-')) dirs.add(e); // subdirectories
  }
  return [...dirs];
}

async function listSessionFiles(workspaceRoots, lookbackMs, scanCap) {
  let projectDirs = [];
  try { projectDirs = await fsp.readdir(PROJECTS_DIR); } catch { return []; }
  const dirs = matchProjectDirs(projectDirs, workspaceRoots);
  const out = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const full = path.join(dir, e);
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (Date.now() - st.mtimeMs > lookbackMs) continue;
      out.push({ sessionId: e.slice(0, -'.jsonl'.length), jsonlPath: full, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, scanCap);
}

// Cheap prefilter for the bulk of a log (big tool results) — must match every
// record type parseSession folds into `files`. "file-history-" covers both
// -snapshot and -delta; missing one silently empties the view.
const FILE_HISTORY_MARKER = '"file-history-';
// Same idea for the title, which is re-appended all session long (136 times in an
// 8.2 MB log) so the last record wins. Reading it from a bounded tail near EOF
// looks tempting and is wrong: consecutive ai-title records sat up to 1.24 MB
// apart in a real log (p99 177 KB), so any window narrower than one turn's tool
// output drops the label back to the first prompt until the next title lands.
const AI_TITLE_MARKER = '"ai-title"';
const CUSTOM_TITLE_MARKER = '"custom-title"';
// Tool calls that mutate files, needed to attribute hunks to Claude vs the
// user. The type marker matches only assistant tool_use blocks — tool RESULT
// lines carry "tool_use_id" but never "type":"tool_use".
const TOOL_USE_MARKER = '"type":"tool_use"';
const TOOL_ERROR_MARKER = '"is_error":true';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Stop collecting op payloads past this budget; attribution degrades to
// "everything is Claude's" (the pre-0.4 behaviour) instead of hoarding memory.
const TOOL_OPS_CHAR_BUDGET = 30e6;

const parseCache = new Map(); // jsonlPath -> {mtimeMs, files, title, cwd, toolOps, errIds}

async function parseSession(s) {
  const cached = parseCache.get(s.jsonlPath);
  if (cached && cached.mtimeMs === s.mtimeMs) return cached;
  const files = new Map(); // absPath -> {backupFileName|null}
  let aiTitle = ''; // Claude's own session title, if it has generated one yet
  let customTitle = ''; // the user's rename, if any
  let prompt = ''; // first real user prompt
  let slug = '';
  let cwd = '';
  let raw = '';
  let needHeader = true;
  let toolOps = []; // ordered {id, name, input} of file-mutating tool calls
  let bashOps = []; // ordered {id, command} of Bash tool calls, for the discovery/attribution fallback below
  let opsChars = 0;
  const errIds = new Set(); // tool_use ids whose result was an error
  try { raw = await fsp.readFile(s.jsonlPath, 'utf8'); } catch { /* unreadable -> empty */ }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // History records and titles run to EOF so the pass cannot exit early, but
    // cwd/prompt live at the top: once they are in, the bulk of the log (big tool
    // results) only needs a substring test, not a full JSON.parse.
    if (!needHeader && !line.includes(FILE_HISTORY_MARKER) && !line.includes(AI_TITLE_MARKER)
      && !line.includes(CUSTOM_TITLE_MARKER) && !line.includes(TOOL_USE_MARKER) && !line.includes(TOOL_ERROR_MARKER)) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if (!slug && obj.slug) slug = obj.slug;
    if (obj.type === 'assistant' && (toolOps || bashOps) && obj.message && Array.isArray(obj.message.content)) {
      for (const it of obj.message.content) {
        if (!it || it.type !== 'tool_use' || !it.input) continue;
        if (toolOps && FILE_TOOLS.has(it.name)) {
          opsChars += JSON.stringify(it.input).length;
          if (opsChars > TOOL_OPS_CHAR_BUDGET) toolOps = null;
          else toolOps.push({ id: it.id, name: it.name, input: it.input });
        } else if (bashOps && it.name === 'Bash' && typeof it.input.command === 'string') {
          bashOps.push({ id: it.id, command: it.input.command });
          if (bashOps.length > 5000) bashOps = null; // safety cap, mirrors the ops char budget's intent
        }
      }
    } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
      for (const it of obj.message.content) {
        if (it && it.type === 'tool_result' && it.is_error && it.tool_use_id) errIds.add(it.tool_use_id);
      }
    }
    // First-write wins in both branches: entries arrive in edit order, so the
    // earliest one carries the lowest @vN — the pre-session baseline.
    const track = (rel, info) => {
      if (!info) return;
      // realParentDir is absent on some entries (e.g. brand-new files with no backup yet);
      // fall back to resolving the relative key against the session cwd.
      const abs = info.realParentDir
        ? path.join(info.realParentDir, path.basename(rel))
        : (cwd ? path.resolve(cwd, rel) : null);
      if (!abs) return;
      if (!files.has(abs)) files.set(abs, { backupFileName: info.backupFileName || null });
    };
    if (obj.type === 'file-history-snapshot' && obj.snapshot && obj.snapshot.trackedFileBackups) {
      for (const [rel, info] of Object.entries(obj.snapshot.trackedFileBackups)) track(rel, info);
    } else if (obj.type === 'file-history-delta' && obj.backup) {
      // Newer Claude Code emits an empty snapshot up front, then one delta per
      // edit instead of re-serializing the whole trackedFileBackups map.
      // obj.backup has the same shape as a trackedFileBackups value, and
      // trackingPath may be workspace-relative or absolute (basename + realParentDir handles both).
      track(obj.trackingPath, obj.backup);
    } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
      aiTitle = obj.aiTitle.trim(); // no !aiTitle guard: Claude refines it, last wins
    } else if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
      customTitle = obj.customTitle.trim();
    } else if (!prompt && obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      let text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
      text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && !/^caveat:/i.test(text) && !text.startsWith('/')) prompt = text.slice(0, 60);
    }
    // slug is only consulted when there is no prompt, so these two end the header scan
    if (cwd && prompt) needHeader = false;
  }
  const title = customTitle || aiTitle || prompt || slug || `session ${s.sessionId.slice(0, 8)}`;
  const parsed = { mtimeMs: s.mtimeMs, files, title, cwd, toolOps, errIds, bashOps: bashOps || [] };
  parseCache.set(s.jsonlPath, parsed);
  return parsed;
}

// All @vN backups per hash in a session's file-history dir, ascending by v.
// The lowest is the pre-session baseline; the highest is the content right
// before Claude's LAST edit (used to anchor replay when the full one fails).
async function backupsByHash(sessionId) {
  const dir = path.join(FILE_HISTORY_DIR, sessionId);
  const byHash = new Map();
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return byHash; }
  for (const e of entries) {
    const m = /^([0-9a-f]+)@v(\d+)$/.exec(e);
    if (!m) continue;
    const v = parseInt(m[2], 10);
    let list = byHash.get(m[1]);
    if (!list) byHash.set(m[1], list = []);
    list.push({ v, file: path.join(dir, e) });
  }
  for (const list of byHash.values()) list.sort((a, b) => a.v - b.v);
  return byHash;
}

function stripBomStr(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// Reconstruct "what Claude last left in the file". Full replay from the
// pre-session snapshot is exact; when mid-session out-of-band changes (git
// commands, manual edits) break it, anchor on the latest checkpoint backup —
// @vN is the content right before Claude's LAST edit, so applying just the
// final op(s) needs only that op's old_string to match. Returns null when
// nothing works (caller falls back to treating every hunk as Claude's).
async function claudeFinalFor(ch) {
  if (!ch.ops || !ch.ops.length) return null;
  const snapText = ch.snapshotPath
    ? stripBomStr(await fsp.readFile(ch.snapshotPath, 'utf8').catch(() => ''))
    : '';
  ch.claudeSnapText = snapText; // callers need it to scope attribution to authored regions
  const full = replayClaudeOps(snapText, ch.ops);
  if (full.ok) return full.text;
  const backups = ch.backupFiles || [];
  const tries = Math.min(ch.ops.length, backups.length, 5);
  for (let t = 0; t < tries; t++) {
    const anchor = await fsp.readFile(backups[backups.length - 1 - t], 'utf8').catch(() => null);
    if (anchor === null) continue;
    const r = replayClaudeOps(stripBomStr(anchor), ch.ops.slice(ch.ops.length - 1 - t));
    if (r.ok) return r.text;
  }
  return null;
}

// -> [{sessionId, mtimeMs, title, changes:[{absPath, status, baselinePath|null, sessionId}]}]
// status: 'modified' | 'created' | 'deleted' (deleted = modified by Claude, since removed from disk).
// Newest session wins per file; net-unchanged files are filtered out.
function stripBomBuf(b) {
  return b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? b.subarray(3) : b;
}

async function computeChanges(workspaceRoots, opts) {
  // scanCap bounds enumeration; maxSessions caps groups that actually have
  // changes (sessions from ancestor dirs often touch nothing in this workspace).
  const sessions = await listSessionFiles(workspaceRoots, opts.lookbackMs, opts.scanCap || 60);
  const seen = new Set();
  const groups = [];
  // Per-call caches so multiple sessions sharing a repo (common) only pay for
  // one `git rev-parse`/`git status` each, not one per session.
  const gitTopCache = new Map(); // dir -> Promise<top|null>
  const cachedGitTop = (dir) => {
    if (!gitTopCache.has(dir)) gitTopCache.set(dir, gitRepoRoot(dir));
    return gitTopCache.get(dir);
  };
  const gitDirtyCache = new Map(); // top -> Promise<Map>
  const cachedGitDirty = (top) => {
    if (!gitDirtyCache.has(top)) gitDirtyCache.set(top, gitDirtyPaths(top));
    return gitDirtyCache.get(top);
  };
  for (const s of sessions) {
    if (groups.length >= opts.maxSessions) break;
    const parsed = await parseSession(s);
    const bashCandidates = parsed.bashOps.length ? bashWriteCandidates(parsed) : new Set();
    if (!parsed.files.size && !bashCandidates.size) continue;
    const byHash = await backupsByHash(s.sessionId);
    const changes = [];
    for (const [abs, info] of parsed.files) {
      if (seen.has(abs)) continue;
      // Scope: workspace files plus extra includes (e.g. Claude's memory under
      // ~/.claude, which lives outside any repo workspace); excludes win (e.g.
      // the /tmp scratchpad Claude uses for throwaway files).
      if (!underAny(abs, workspaceRoots) && !matchAnyGlob(abs, opts.includeGlobs)) continue;
      if (matchAnyGlob(abs, opts.excludeGlobs)) continue;
      let created = !info.backupFileName;
      let snapshotPath = null;
      let backupFiles = null;
      if (!created) {
        const list = byHash.get(info.backupFileName.split('@')[0]);
        if (!list) continue; // backups pruned; nothing to diff against
        backupFiles = list.map((x) => x.file);
        if (list[0].v === 1) snapshotPath = list[0].file; // @v1 = true pre-session content
        else created = true; // no @v1 on disk => file was born in this session
      } else {
        // created files can still gain later backups (content before Claude's
        // 2nd+ edit) — useful as replay anchors
        const list = byHash.get(hashPath(abs));
        if (list) backupFiles = list.map((x) => x.file);
      }
      // A "keep" overlay (ours, in extension storage) supersedes the snapshot:
      // it holds the content the user has already accepted for this session.
      let overlay = null;
      if (opts.overlaysDir) {
        const op = overlayPathFor(opts.overlaysDir, abs);
        if (await fsp.access(op).then(() => true, () => false)) overlay = op;
      }
      if (overlay) created = false; // accepted content exists; undo restores it, never deletes
      const baselinePath = overlay || snapshotPath;
      const baseBuf = created ? Buffer.alloc(0) : await fsp.readFile(baselinePath).catch(() => null);
      if (baseBuf === null) continue;
      const curBuf = await fsp.readFile(abs).catch(() => null);
      let status = null;
      // BOM-insensitive: VS Code treats a UTF-8 BOM as encoding metadata, so
      // overlays written from editor text are BOM-less while disk may have one.
      if (curBuf === null) status = created ? null : 'deleted';
      else if (!stripBomBuf(baseBuf).equals(stripBomBuf(curBuf))) status = created ? 'created' : 'modified';
      if (!status) continue; // net no-op: fall through so an older session's diff can surface
      seen.add(abs);
      // Ordered successful file-tool calls Claude made to THIS file in THIS
      // session; null when unknown (ops budget blown / old transcript format).
      const ops = parsed.toolOps
        ? parsed.toolOps.filter((op) => {
            if (parsed.errIds.has(op.id)) return false;
            const fp = op.input.file_path || op.input.notebook_path;
            if (!fp) return false;
            const oAbs = path.isAbsolute(fp) ? fp : (parsed.cwd ? path.resolve(parsed.cwd, fp) : fp);
            return canonPath(oAbs) === canonPath(abs);
          })
        : null;
      // Present in file-history AND named by a Bash command this session: a
      // replay that only sees the Edit/Write ops would "succeed" while
      // silently missing the Bash-authored part. Force attribution to fall
      // back to "show everything" (extension.js skips replay when this is
      // set) rather than let it confidently mislabel those hunks as the user's.
      const bashTouched = bashCandidates.has(abs);
      changes.push({ absPath: abs, status, baselinePath, snapshotPath, backupFiles, sessionId: s.sessionId, ops, bashTouched });
    }
    // Files Claude touched ONLY through Bash never got a file-history entry
    // above, so they're still entirely undiscovered at this point. A git
    // repo's own dirty-state is the only other source of "what changed" we
    // have; use it as a stand-in for Claude Code's own checkpoint, gated on
    // this session actually having named the path in a Bash command.
    if (bashCandidates.size && opts.overlaysDir) {
      const gitBaselinesDir = path.join(path.dirname(opts.overlaysDir), 'git-baselines');
      for (const abs of bashCandidates) {
        if (seen.has(abs)) continue;
        if (!underAny(abs, workspaceRoots) && !matchAnyGlob(abs, opts.includeGlobs)) continue;
        if (matchAnyGlob(abs, opts.excludeGlobs)) continue;
        const curBuf = await fsp.readFile(abs).catch(() => null);
        if (curBuf === null) continue; // bash-deleted files aren't discoverable this way
        const top = await cachedGitTop(path.dirname(abs));
        if (!top) continue; // not a git repo (or git unavailable) -> no trustworthy baseline
        const dirty = await cachedGitDirty(top);
        const kind = dirty.get(abs);
        if (!kind) continue; // git doesn't see it as changed -> nothing to show
        let created = kind === 'untracked';
        let snapshotPath = null;
        if (!created) {
          snapshotPath = await materializeGitHead(top, abs, gitBaselinesDir);
          if (!snapshotPath) continue; // no HEAD blob to diff against -> skip rather than guess
        }
        let overlay = null;
        const op = overlayPathFor(opts.overlaysDir, abs);
        if (await fsp.access(op).then(() => true, () => false)) overlay = op;
        if (overlay) created = false;
        const baselinePath = overlay || snapshotPath;
        const baseBuf = created ? Buffer.alloc(0) : await fsp.readFile(baselinePath).catch(() => null);
        if (baseBuf === null) continue;
        let status = null;
        if (!stripBomBuf(baseBuf).equals(stripBomBuf(curBuf))) status = created ? 'created' : 'modified';
        if (!status) continue;
        seen.add(abs);
        // ops: null -> analyzeChange never attempts a replay (there is nothing
        // to replay — Bash isn't Edit/Write), so this always falls back to
        // showing every hunk, unattributed. Same safe default as any other
        // unreplayable case.
        changes.push({ absPath: abs, status, baselinePath, snapshotPath, backupFiles: null, sessionId: s.sessionId, ops: null, bashTouched: true, viaBash: true });
      }
    }
    if (changes.length) {
      groups.push({ sessionId: s.sessionId, mtimeMs: s.mtimeMs, title: parsed.title, changes });
    }
  }
  return groups;
}

module.exports = {
  CLAUDE_DIR,
  PROJECTS_DIR,
  FILE_HISTORY_DIR,
  sanitizeProjectDir,
  hashPath,
  overlayPathFor,
  matchProjectDirs,
  listSessionFiles,
  parseSession,
  computeChanges,
  computeHunks,
  applyHunkToBase,
  revertHunkInCur,
  applyStringEdits,
  replayClaudeOps,
  attributeHunks,
  claudeFinalFor,
  globToRegExp,
  matchAnyGlob,
  extractBashWriteTargets,
  bashWriteCandidates,
};
