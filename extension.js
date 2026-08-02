'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

let ctx;
let sc;
let treeView;
let statusItem;
let overlaysDir;
const treeEmitter = new vscode.EventEmitter();
const decoEmitter = new vscode.EventEmitter();
const baselineEmitter = new vscode.EventEmitter();
const codeLensEmitter = new vscode.EventEmitter();
const groupsById = new Map(); // sessionId -> SourceControlResourceGroup
let changeByUri = new Map(); // fileUri string -> change
let lastGroups = []; // visible (non-dismissed) groups, feeds tree + scm
let refreshTimer = null;
let watchers = [];
let lastRenderSignature = null; // skip redraw when a refresh finds nothing visibly different

function cfg() {
  const c = vscode.workspace.getConfiguration('claudeEdits');
  return {
    lookbackMs: Math.max(1, c.get('lookbackHours', 48)) * 3600 * 1000,
    maxSessions: Math.max(1, c.get('maxSessions', 6)),
    codeLens: c.get('codeLens', true),
    claudeOnly: c.get('claudeOnly', true),
    scmView: c.get('scmView', false),
    showFileBadge: c.get('showFileBadge', false),
    includeGlobs: c.get('includeGlobs', ['**/.claude/**']),
    excludeGlobs: c.get('excludeGlobs', ['/tmp/claude-*/**']),
  };
}

// After keeping/reverting a chunk, move the cursor to the next remaining one
// so review flows chunk-to-chunk without manual navigation.
async function focusNextHunk(uri, ch, fromLine) {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const baseText = await effBaselineText(ch);
    let hunks = lib.computeHunks(baseText, doc.getText());
    if (cfg().claudeOnly) {
      if (ch.claudeFinal === undefined) return;
      hunks = lib.attributeHunks(baseText, doc.getText(), hunks, ch.claudeFinal, ch.claudeSnapText ?? "").filter((h) => h.claude);
    }
    const next = hunks.find((h) => h.curStart > fromLine) || hunks[0];
    if (!next) return;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (!editor) return;
    const pos = new vscode.Position(Math.max(0, Math.min(next.curStart, doc.lineCount - 1)), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch { /* navigation is best-effort */ }
}

// Computes +/− line counts and (when the transcript replay succeeds) which
// outstanding hunks Claude authored. Best-effort: on any failure the change
// keeps the pre-attribution behaviour (everything shown).
async function analyzeChange(ch, claudeOnly) {
  ch.analysis = null;
  try {
    const effP = effBaselinePath(ch);
    const effText = effP ? stripBom(await fs.promises.readFile(effP, 'utf8')) : '';
    if (ch.status === 'deleted') {
      ch.analysis = { ok: false, add: 0, del: effText ? effText.split('\n').length : 0, claudeCount: 1 };
      return;
    }
    const curText = stripBom(await fs.promises.readFile(ch.absPath, 'utf8'));
    let hunks = lib.computeHunks(effText, curText);
    let claudeOk = false;
    if (claudeOnly && ch.ops && ch.ops.length) {
      const cf = await lib.claudeFinalFor(ch); // full replay, else anchored on last backup
      if (cf !== null) {
        ch.claudeFinal = cf;
        hunks = lib.attributeHunks(effText, curText, hunks, cf, ch.claudeSnapText ?? "");
        claudeOk = true;
      }
    }
    const counted = claudeOk ? hunks.filter((h) => h.claude) : hunks;
    ch.analysis = {
      ok: claudeOk,
      add: counted.reduce((n, h) => n + h.curCount, 0),
      del: counted.reduce((n, h) => n + h.baseCount, 0),
      claudeCount: counted.length,
    };
  } catch { /* attribution is best-effort */ }
}

function roots() {
  return (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// The provider resolves overlay-vs-snapshot at read time, so an open diff
// refreshes in place when a hunk is kept. The query changes when the newest
// session for a file changes, so remember every URI we ever handed out and
// fire change events for all of them.
const issuedBaselineUris = new Map(); // absPath -> Set<uriString>

function baselineUriFor(ch) {
  const query = Buffer.from(JSON.stringify({ b: ch.snapshotPath || '' })).toString('base64url');
  // derive from Uri.file so Windows paths (C:\...) become valid URI paths
  const uri = vscode.Uri.file(ch.absPath).with({ scheme: 'claude-baseline', query });
  let set = issuedBaselineUris.get(ch.absPath);
  if (!set) issuedBaselineUris.set(ch.absPath, set = new Set());
  if (set.size < 20) set.add(uri.toString());
  return uri;
}

// Overlay if the user has kept anything, else the pre-session snapshot (null
// for files Claude created).
function effBaselinePath(ch) {
  const op = lib.overlayPathFor(overlaysDir, ch.absPath);
  if (fs.existsSync(op)) return op;
  return ch.snapshotPath || null;
}

async function effBaselineText(ch) {
  const p = effBaselinePath(ch);
  if (!p) return '';
  return stripBom(await fs.promises.readFile(p, 'utf8'));
}

async function writeOverlay(ch, content) {
  const op = lib.overlayPathFor(overlaysDir, ch.absPath);
  await fs.promises.mkdir(path.dirname(op), { recursive: true });
  await fs.promises.writeFile(op, content);
  refreshGen++; // invalidate any in-flight refresh computed against pre-keep state
}

function openDocFor(absPath) {
  const uriStr = vscode.Uri.file(absPath).toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
}

function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 90 * 1000) return 'just now';
  if (d < 90 * 60 * 1000) return `${Math.round(d / 60000)}m ago`;
  if (d < 36 * 3600 * 1000) return `${Math.round(d / 3600000)}h ago`;
  return `${Math.round(d / 86400000)}d ago`;
}

function keyOf(ch) {
  return `${ch.sessionId}:${ch.absPath}`;
}

function dismissedMap() {
  return ctx.workspaceState.get('claudeEdits.dismissed', {});
}

async function dismiss(changes) {
  const m = { ...dismissedMap() };
  for (const ch of changes) {
    let mt = 0;
    try { mt = fs.statSync(ch.absPath).mtimeMs; } catch { /* deleted -> 0 hides it until recreated */ }
    m[keyOf(ch)] = mt;
  }
  await ctx.workspaceState.update('claudeEdits.dismissed', m);
}

function isDismissed(ch, m) {
  const v = m[keyOf(ch)];
  if (v === undefined) return false;
  let mt = -1;
  try { mt = fs.statSync(ch.absPath).mtimeMs; } catch { /* missing file stays dismissed */ }
  return mt <= v + 1; // edited again after "Keep" -> resurface
}

function fireUiEvents() {
  treeEmitter.fire(undefined);
  decoEmitter.fire(undefined);
  codeLensEmitter.fire();
  for (const ch of changeByUri.values()) baselineUriFor(ch); // register current URIs
  for (const set of issuedBaselineUris.values()) {
    for (const s of set) baselineEmitter.fire(vscode.Uri.parse(s));
  }
  updateActiveContext();
}

let refreshGen = 0;

async function refresh() {
  const gen = ++refreshGen;
  const r = roots();
  const conf = cfg();
  let groups = [];
  try {
    groups = r.length ? await lib.computeChanges(r, { ...conf, overlaysDir }) : [];
  } catch (e) {
    console.error('claude-edits-scm refresh failed:', e);
  }
  if (gen !== refreshGen) return; // a newer refresh superseded this one
  const dism = dismissedMap();
  changeByUri = new Map();
  const visGroups = [];
  let total = 0;

  for (const g of groups) {
    const changes = [];
    for (const ch of g.changes) {
      if (isDismissed(ch, dism)) continue;
      await analyzeChange(ch, conf.claudeOnly);
      // hide files whose remaining diffs are the user's own edits
      if (conf.claudeOnly && ch.analysis?.ok && ch.status === 'modified' && ch.analysis.claudeCount === 0) continue;
      changeByUri.set(vscode.Uri.file(ch.absPath).toString(), ch);
      changes.push(ch);
    }
    if (changes.length) {
      visGroups.push({ ...g, changes });
      total += changes.length;
    }
  }
  if (gen !== refreshGen) return; // analysis reads may have raced a newer refresh
  lastGroups = visGroups;

  // Claude edits every few seconds, and each one touches the file-history
  // watcher regardless of whether it changes anything THIS workspace is
  // showing (a different file, an already-fully-kept file, excluded paths).
  // Redrawing the tree/decorations/CodeLenses on every such no-op refresh is
  // what caused the reported flicker — skip the visible re-render entirely
  // when the rendered content is identical to last time.
  const signature = JSON.stringify(visGroups.map((g) => [
    g.sessionId, g.title, g.mtimeMs,
    g.changes.map((c) => [c.absPath, c.status, c.analysis?.add, c.analysis?.del, c.analysis?.ok]),
  ]));
  if (signature === lastRenderSignature) return;
  lastRenderSignature = signature;

  if (sc) updateScm(visGroups);
  fireUiEvents();

  treeView.badge = total
    ? { value: total, tooltip: `${total} file(s) changed by Claude` }
    : undefined;
  if (total) {
    statusItem.text = `$(diff) Claude ${total}`;
    statusItem.tooltip = `${total} file(s) changed by Claude — click to review`;
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

function updateScm(visGroups) {
  const alive = new Set();
  for (const g of visGroups) {
    alive.add(g.sessionId);
    let grp = groupsById.get(g.sessionId);
    if (!grp) {
      grp = sc.createResourceGroup(g.sessionId, g.sessionId.slice(0, 8));
      grp.hideWhenEmpty = true;
      groupsById.set(g.sessionId, grp);
    }
    grp.label = `${relTime(g.mtimeMs)} — ${g.title || g.sessionId.slice(0, 8)}`;
    grp.resourceStates = g.changes.map((ch) => ({
      resourceUri: vscode.Uri.file(ch.absPath),
      command: { title: 'Open Diff', command: 'claudeEdits.openDiff', arguments: [ch] },
      contextValue: 'claudeEdit',
      decorations: {
        strikeThrough: ch.status === 'deleted',
        faded: false,
        tooltip: statusLabel(ch),
      },
    }));
  }
  for (const [id, grp] of groupsById) {
    if (!alive.has(id)) {
      grp.dispose();
      groupsById.delete(id);
    }
  }
  sc.count = lastGroups.reduce((n, g) => n + g.changes.length, 0);
}

function statusLabel(ch) {
  return ch.status === 'created' ? 'Created by Claude'
    : ch.status === 'deleted' ? 'Modified by Claude, since deleted from disk'
    : 'Modified by Claude';
}

function updateActiveContext() {
  const uri = vscode.window.activeTextEditor?.document?.uri;
  const active = !!(uri && changeByUri.has(uri.toString()));
  vscode.commands.executeCommand('setContext', 'claudeEdits.activeFileChanged', active);
}

const treeProvider = {
  onDidChangeTreeData: treeEmitter.event,
  getChildren(el) {
    if (!el) return lastGroups.length === 1 ? lastGroups[0].changes : lastGroups;
    if (el.changes) return el.changes;
    return [];
  },
  getTreeItem(el) {
    if (el.changes) { // session node
      const it = new vscode.TreeItem(
        `${relTime(el.mtimeMs)} — ${el.title || el.sessionId.slice(0, 8)}`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      it.id = 's:' + el.sessionId;
      it.contextValue = 'claudeSession';
      it.iconPath = new vscode.ThemeIcon('comment-discussion');
      it.description = `${el.changes.length}`;
      return it;
    }
    const it = new vscode.TreeItem(vscode.Uri.file(el.absPath));
    it.id = el.sessionId + ':' + el.absPath;
    const a = el.analysis;
    it.description = a ? `+${a.add} −${a.del} · ${el.status}` : el.status;
    it.tooltip = `${statusLabel(el)}${a ? ` (+${a.add} −${a.del})` : ''}`
      + (a && !a.ok && el.status !== 'deleted' ? '\nattribution unavailable — counts include all changes; review via the diff' : '')
      + `\n${el.absPath}`;
    it.command = { title: 'Open Diff', command: 'claudeEdits.openDiff', arguments: [el] };
    it.contextValue = 'claudeEdit';
    if (el.status === 'deleted') it.iconPath = new vscode.ThemeIcon('trash');
    return it;
  },
};

// A pure trailing debounce resets on every edit, so continuous edit bursts
// (Claude iterating every few seconds) still redraw the tree on close to
// every edit once gaps exceed the window. VS Code documents per-node tree
// refreshes as unreliable once a tree has more than one top-level item
// (github.com/microsoft/vscode#244952) — our tree promotes files to root
// when only one session is shown, so that's easy to hit. Rather than risk
// rows silently going stale, widen the window so bursts coalesce into far
// fewer full redraws instead of trying to make each redraw cheaper.
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 1500);
}

function chsFromArgs(args) {
  const out = [];
  const visit = (a) => {
    if (!a) return;
    if (Array.isArray(a)) return a.forEach(visit);
    if (a.absPath) { if (!out.includes(a)) out.push(a); return; }
    if (a.changes) return a.changes.forEach(visit); // session node
    if (a.resourceUri) {
      const ch = changeByUri.get(a.resourceUri.toString());
      if (ch && !out.includes(ch)) out.push(ch);
    }
  };
  args.forEach(visit);
  return out;
}

async function openDiff(...args) {
  const ch = chsFromArgs(args)[0];
  if (!ch) return;
  const left = baselineUriFor(ch);
  if (ch.status === 'deleted') {
    await vscode.window.showTextDocument(left, { preview: true });
    return;
  }
  const label = `${path.basename(ch.absPath)} (Claude — ${ch.status})`;
  await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(ch.absPath), label, { preview: true });
}

// ---------------------------------------------------------------------------
// Keep / Undo — file level
// ---------------------------------------------------------------------------

// "Keep" = accept the current content as the new baseline (overlay). The file
// disappears from every surface because baseline == current; if Claude edits
// it again later, only the new delta shows.
async function acceptFiles(chs) {
  for (const ch of chs) {
    try {
      if (ch.status === 'deleted') { await dismiss([ch]); continue; }
      // Save dirty buffers first so the overlay matches disk (what refresh
      // compares) while still keeping exactly what the user sees.
      const doc = openDocFor(ch.absPath);
      if (doc && doc.isDirty) await doc.save();
      await writeOverlay(ch, stripBom(await fs.promises.readFile(ch.absPath, 'utf8')));
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Edits: keep failed for ${path.basename(ch.absPath)}: ${e.message}`);
    }
  }
  scheduleRefresh();
  fireUiEvents();
}

async function undoOne(ch) {
  const uri = vscode.Uri.file(ch.absPath);
  const eff = effBaselinePath(ch);
  if (!eff) { // created, nothing accepted yet -> undo means delete
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
    return;
  }
  const baseline = await fs.promises.readFile(eff);
  if (!fs.existsSync(ch.absPath)) { // deleted from disk -> recreate
    await vscode.workspace.fs.writeFile(uri, baseline);
    return;
  }
  // modified: go through a WorkspaceEdit so Ctrl+Z works in an open editor
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), baseline.toString('utf8'));
    const ok = await vscode.workspace.applyEdit(we); // resolves false on failure, does not throw
    if (ok) await (await vscode.workspace.openTextDocument(uri)).save();
    else await vscode.workspace.fs.writeFile(uri, baseline);
  } catch {
    await vscode.workspace.fs.writeFile(uri, baseline); // binary / unopenable fallback
  }
}

async function undoMany(chs, preconfirmed) {
  const created = chs.filter((c) => c.status === 'created');
  if (created.length && !preconfirmed) {
    const names = created.slice(0, 8).map((c) => path.basename(c.absPath)).join(', ');
    const pick = await vscode.window.showWarningMessage(
      `Delete ${created.length} file(s) created by Claude? (${names}${created.length > 8 ? ', …' : ''})`,
      { modal: true }, 'Delete');
    if (pick !== 'Delete') return;
  }
  for (const ch of chs) {
    try {
      await undoOne(ch);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Edits: undo failed for ${path.basename(ch.absPath)}: ${e.message}`);
    }
  }
  scheduleRefresh();
  fireUiEvents();
}

async function undo(...args) {
  const chs = chsFromArgs(args);
  if (chs.length) await undoMany(chs, false);
}

async function keep(...args) {
  const chs = chsFromArgs(args);
  if (chs.length) await acceptFiles(chs);
}

async function keepAll() {
  const chs = [...changeByUri.values()];
  if (!chs.length) {
    vscode.window.showInformationMessage('Claude Edits: no pending changes. If you expected some, run "Claude Edits: Diagnostics".');
    return;
  }
  await acceptFiles(chs);
}

async function undoAll() {
  const chs = [...changeByUri.values()];
  if (!chs.length) {
    vscode.window.showInformationMessage('Claude Edits: no pending changes to undo. If you expected some, run "Claude Edits: Diagnostics".');
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `Restore ${chs.length} file(s) to their baseline? Files Claude created (and not yet kept) will be deleted.`,
    { modal: true }, 'Undo All');
  if (pick !== 'Undo All') return;
  await undoMany(chs, true);
}

function activeCh() {
  const uri = vscode.window.activeTextEditor?.document?.uri;
  return uri ? changeByUri.get(uri.toString()) : undefined;
}

// ---------------------------------------------------------------------------
// Keep / Revert — hunk level (CodeLens)
// ---------------------------------------------------------------------------

function matchHunk(hunks, wanted) {
  const exact = hunks.find((h) => h.baseStart === wanted.baseStart && h.baseCount === wanted.baseCount
    && h.curStart === wanted.curStart && h.curCount === wanted.curCount);
  if (exact) return exact;
  const wEnd = wanted.curStart + Math.max(wanted.curCount, 1);
  const overlapping = hunks.filter((h) => h.curStart < wEnd && wanted.curStart < h.curStart + Math.max(h.curCount, 1));
  return overlapping.length === 1 ? overlapping[0] : null;
}

async function hunkContext(uri, wanted) {
  const ch = changeByUri.get(uri.toString());
  if (!ch) return null;
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.isDirty) await doc.save(); // keep overlay/doc/disk consistent
  const baseText = await effBaselineText(ch);
  const curText = doc.getText();
  const hunks = lib.computeHunks(baseText, curText);
  const h = matchHunk(hunks, wanted);
  if (!h) {
    vscode.window.showInformationMessage('Claude Edits: that change is no longer where it was — lenses refreshed.');
    codeLensEmitter.fire();
    return null;
  }
  return { ch, doc, baseText, curText, h };
}

async function keepHunk(uri, wanted) {
  const c = await hunkContext(uri, wanted);
  if (!c) return;
  const nb = lib.applyHunkToBase(c.baseText.split('\n'), c.curText.split('\n'), c.h);
  await writeOverlay(c.ch, nb.join('\n'));
  fireUiEvents();
  scheduleRefresh();
  await focusNextHunk(uri, c.ch, c.h.curStart);
}

async function revertHunk(uri, wanted) {
  const c = await hunkContext(uri, wanted);
  if (!c) return;
  const nc = lib.revertHunkInCur(c.baseText.split('\n'), c.curText.split('\n'), c.h);
  const we = new vscode.WorkspaceEdit();
  we.replace(uri, new vscode.Range(c.doc.positionAt(0), c.doc.positionAt(c.curText.length)), nc.join('\n'));
  const ok = await vscode.workspace.applyEdit(we); // resolves false on failure
  if (!ok) {
    vscode.window.showErrorMessage(`Claude Edits: revert failed for ${path.basename(uri.fsPath)} — the document changed underneath; try again.`);
    return;
  }
  await c.doc.save(); // persist so the disk-based list stays in sync (Ctrl+Z still works)
  fireUiEvents();
  scheduleRefresh();
  await focusNextHunk(uri, c.ch, c.h.curStart);
}

const codeLensProvider = {
  onDidChangeCodeLenses: codeLensEmitter.event,
  async provideCodeLenses(doc) {
    if (!cfg().codeLens) return [];
    const ch = changeByUri.get(doc.uri.toString());
    if (!ch || ch.status === 'deleted') return [];
    if (ch.status === 'created' && !effBaselinePath(ch)) {
      const range = new vscode.Range(0, 0, 0, 0);
      return [
        new vscode.CodeLens(range, { title: '✅ Keep new file', command: 'claudeEdits.keep', arguments: [ch] }),
        new vscode.CodeLens(range, { title: '🗑️ Delete file', command: 'claudeEdits.undo', arguments: [ch] }),
      ];
    }
    const baseText = await effBaselineText(ch);
    let hunks = lib.computeHunks(baseText, doc.getText());
    // Lens ONLY hunks we can positively attribute to Claude. When attribution
    // is unavailable (replay failed, subagent edits with no transcript ops),
    // show no chunk lenses at all rather than popping Keep/Undo on the user's
    // own typing — the file row and diff still show everything.
    if (cfg().claudeOnly) {
      if (ch.claudeFinal === undefined) return [];
      hunks = lib.attributeHunks(baseText, doc.getText(), hunks, ch.claudeFinal, ch.claudeSnapText ?? "").filter((h) => h.claude);
    }
    const lenses = [];
    for (const h of hunks) {
      const line = Math.max(0, Math.min(h.curStart, doc.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(new vscode.CodeLens(range, { title: '✅ Keep', command: 'claudeEdits.keepHunk', arguments: [doc.uri, h] }));
      lenses.push(new vscode.CodeLens(range, { title: '❌ Undo', command: 'claudeEdits.revertHunk', arguments: [doc.uri, h] }));
      if (hunks.length > 1 && h === hunks[0]) {
        lenses.push(new vscode.CodeLens(range, { title: `✅✅ Keep all ${hunks.length}`, command: 'claudeEdits.keep', arguments: [ch] }));
      }
    }
    return lenses;
  },
};

// ---------------------------------------------------------------------------

function armWatchers() {
  for (const w of watchers) { try { w.close(); } catch { /* noop */ } }
  watchers = [];
  try { watchers.push(fs.watch(lib.FILE_HISTORY_DIR, { recursive: true }, scheduleRefresh)); } catch { /* dir may not exist yet */ }
  for (const r of roots()) {
    const d = path.join(lib.PROJECTS_DIR, lib.sanitizeProjectDir(r));
    try { watchers.push(fs.watch(d, scheduleRefresh)); } catch { /* dir may not exist yet */ }
  }
}

// VS Code hides all CodeLens inside diff editors unless diffEditor.codeLens is
// on, which silently removes our per-hunk Keep/Revert actions from diff views.
// Offer (once) to enable it.
async function ensureDiffCodeLensSetting() {
  try {
    const diffCfg = vscode.workspace.getConfiguration('diffEditor');
    if (diffCfg.get('codeLens') === true) return;
    if (ctx.globalState.get('claudeEdits.diffCodeLensPromptDone')) return;
    const pick = await vscode.window.showInformationMessage(
      'Claude Edits: enable "Diff Editor: Code Lens" so per-change Keep/Revert actions also show inside diff views?',
      'Enable', 'Not now');
    await ctx.globalState.update('claudeEdits.diffCodeLensPromptDone', true);
    if (pick === 'Enable') await diffCfg.update('codeLens', true, vscode.ConfigurationTarget.Global);
  } catch (e) {
    console.error('claude-edits-scm: diffEditor.codeLens prompt failed:', e);
  }
}

let diagChannel;

// One paste-able report answering "why is the list empty?" — used to debug
// installs on machines we cannot see (path casing, missing data dirs, etc.).
async function diagnostics() {
  if (!diagChannel) diagChannel = vscode.window.createOutputChannel('Claude Edits');
  const out = diagChannel;
  out.clear();
  out.show(true);
  const os = require('os');
  const opts = cfg();
  out.appendLine(`claude-edits-scm diagnostics — ${new Date().toISOString()}`);
  out.appendLine(`platform=${process.platform} node=${process.version} vscode=${vscode.version}`);
  out.appendLine(`home=${os.homedir()}`);
  out.appendLine(`lookbackHours=${opts.lookbackMs / 3600000} maxSessions=${opts.maxSessions}`);
  const r = roots();
  out.appendLine(`workspaceRoots=${JSON.stringify(r)}`);
  out.appendLine(`sanitized=${JSON.stringify(r.map(lib.sanitizeProjectDir))}`);
  let projectDirs = [];
  try { projectDirs = await fs.promises.readdir(lib.PROJECTS_DIR); } catch (e) { out.appendLine(`PROJECTS_DIR ${lib.PROJECTS_DIR} unreadable: ${e.message}`); }
  out.appendLine(`projectDirs total=${projectDirs.length}: ${JSON.stringify(projectDirs.slice(0, 30))}${projectDirs.length > 30 ? ' …' : ''}`);
  const matched = lib.matchProjectDirs(projectDirs, r);
  out.appendLine(`matched project dirs=${JSON.stringify(matched)}`);
  try { await fs.promises.access(lib.FILE_HISTORY_DIR); out.appendLine(`FILE_HISTORY_DIR ok: ${lib.FILE_HISTORY_DIR}`); } catch { out.appendLine(`FILE_HISTORY_DIR MISSING: ${lib.FILE_HISTORY_DIR}`); }
  const sessions = await lib.listSessionFiles(r, opts.lookbackMs, 60);
  out.appendLine(`sessions in lookback=${sessions.length}`);
  for (const s of sessions.slice(0, 10)) {
    const parsed = await lib.parseSession(s);
    const under = [...parsed.files.keys()].filter((p) => r.some((root) => p.toLowerCase().startsWith(root.toLowerCase())));
    out.appendLine(`  ${s.sessionId.slice(0, 8)} mtime=${new Date(s.mtimeMs).toISOString()} tracked=${parsed.files.size} underWorkspace≈${under.length}`);
    for (const p of [...parsed.files.keys()].slice(0, 5)) out.appendLine(`    tracked: ${p}`);
  }
  try {
    const groups = await lib.computeChanges(r, { ...opts, overlaysDir });
    out.appendLine(`groups with changes=${groups.length}; entries=${groups.reduce((n, g) => n + g.changes.length, 0)}`);
    for (const g of groups) for (const c of g.changes) out.appendLine(`  ${c.status}: ${c.absPath}`);
    out.appendLine(`dismissed keys=${Object.keys(dismissedMap()).length}`);
  } catch (e) {
    out.appendLine(`computeChanges FAILED: ${e.stack || e.message}`);
  }
  out.appendLine('— end —');
}

async function gcOverlays() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let entries = [];
  try { entries = await fs.promises.readdir(overlaysDir); } catch { return; }
  for (const e of entries) {
    const p = path.join(overlaysDir, e);
    try {
      const st = await fs.promises.stat(p);
      if (st.mtimeMs < cutoff) await fs.promises.rm(p, { recursive: true, force: true });
    } catch { /* noop */ }
  }
}

function activate(context) {
  ctx = context;
  overlaysDir = path.join(context.globalStorageUri.fsPath, 'overlays');
  fs.mkdirSync(overlaysDir, { recursive: true });
  gcOverlays();
  ensureDiffCodeLensSetting();

  const r = roots();
  // Optional SCM provider: shows a "Claude Edits" section in the Source
  // Control view and powers the quick-diff gutter/peek in editors. Off by
  // default — most users want only the Changed Files tree. Toggling the
  // setting takes effect after a window reload.
  if (cfg().scmView) {
    sc = vscode.scm.createSourceControl('claudeEdits', 'Claude Edits', r.length ? vscode.Uri.file(r[0]) : undefined);
    sc.inputBox.visible = false;
    sc.quickDiffProvider = {
      label: 'Claude Edits',
      provideOriginalResource(uri) {
        const ch = changeByUri.get(uri.toString());
        return ch && ch.status === 'modified' ? baselineUriFor(ch) : null;
      },
    };
    context.subscriptions.push(sc);
  }

  // Tree view mounted inside the Claude Code sidebar container (see package.json "views").
  treeView = vscode.window.createTreeView('claudeEditsView', { treeDataProvider: treeProvider });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'claudeEditsView.focus';

  context.subscriptions.push(
    treeView,
    statusItem,
    vscode.workspace.registerTextDocumentContentProvider('claude-baseline', {
      onDidChange: baselineEmitter.event,
      provideTextDocumentContent(uri) {
        try {
          const filePath = uri.fsPath; // works for non-file schemes; correct on Windows
          const overlay = lib.overlayPathFor(overlaysDir, filePath);
          if (fs.existsSync(overlay)) return stripBom(fs.readFileSync(overlay, 'utf8'));
          // prefer the live change entry (its snapshot follows the newest
          // session); the query's snapshot path is the fallback for stale URIs
          const ch = changeByUri.get(vscode.Uri.file(filePath).toString());
          if (ch && ch.snapshotPath) return stripBom(fs.readFileSync(ch.snapshotPath, 'utf8'));
          const { b } = JSON.parse(Buffer.from(uri.query, 'base64url').toString());
          return b ? stripBom(fs.readFileSync(b, 'utf8')) : '';
        } catch {
          return '';
        }
      },
    }),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decoEmitter.event,
      provideFileDecoration(uri) {
        if (!cfg().showFileBadge) return undefined;
        const ch = changeByUri.get(uri.toString());
        if (!ch) return undefined;
        return {
          badge: 'C', // always this one letter — just marks "Claude touched this file", nothing else varies
          tooltip: statusLabel(ch),
          color: new vscode.ThemeColor(ch.status === 'created'
            ? 'gitDecoration.untrackedResourceForeground'
            : 'gitDecoration.modifiedResourceForeground'),
        };
      },
    }),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    vscode.commands.registerCommand('claudeEdits.refresh', () => refresh()),
    vscode.commands.registerCommand('claudeEdits.diagnostics', diagnostics),
    // Programmatic API for other extensions / automation:
    // await vscode.commands.executeCommand('claudeEdits.getChanges')
    vscode.commands.registerCommand('claudeEdits.getChanges', () => lastGroups.map((g) => ({
      sessionId: g.sessionId,
      title: g.title,
      changes: g.changes.map((c) => ({
        file: c.absPath,
        status: c.status,
        add: c.analysis ? c.analysis.add : null,
        del: c.analysis ? c.analysis.del : null,
        attributed: !!(c.analysis && c.analysis.ok),
      })),
    }))),
    vscode.commands.registerCommand('claudeEdits.openDiff', openDiff),
    vscode.commands.registerCommand('claudeEdits.undo', undo),
    vscode.commands.registerCommand('claudeEdits.keep', keep),
    vscode.commands.registerCommand('claudeEdits.undoAll', undoAll),
    vscode.commands.registerCommand('claudeEdits.keepAll', keepAll),
    vscode.commands.registerCommand('claudeEdits.keepHunk', keepHunk),
    vscode.commands.registerCommand('claudeEdits.revertHunk', revertHunk),
    vscode.commands.registerCommand('claudeEdits.keepFileInEditor', () => { const ch = activeCh(); if (ch) acceptFiles([ch]); }),
    vscode.commands.registerCommand('claudeEdits.revertFileInEditor', () => { const ch = activeCh(); if (ch) undoMany([ch], false); }),
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.window.onDidChangeActiveTextEditor(updateActiveContext),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { armWatchers(); scheduleRefresh(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeEdits')) return;
      codeLensEmitter.fire();
      decoEmitter.fire(undefined); // e.g. showFileBadge toggled — data may be unchanged, but rendering must update now
      lastRenderSignature = null; // force the next refresh to redraw even if the data itself is identical
      scheduleRefresh();
    }),
    { dispose: () => { for (const w of watchers) { try { w.close(); } catch { /* noop */ } } } },
  );

  armWatchers();
  const rearm = setInterval(() => { armWatchers(); scheduleRefresh(); }, 60 * 1000); // safety net for missed fs events
  context.subscriptions.push({ dispose: () => clearInterval(rearm) });
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
