# Claude Diff & Edit

[![CI](https://github.com/Danielfarkashh/claude-edits-scm/actions/workflows/ci.yml/badge.svg)](https://github.com/Danielfarkashh/claude-edits-scm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Diff and review **Claude Code**'s edits, additive to the workflow you already have — no webview, no chat wrapper, keep bypass/auto mode on.

## Where changes show up (no navigation needed)

- **"Changed Files" view inside the Claude Code sidebar** (stacked under the chat), grouped by session, with a count badge on the Claude icon. Sessions carry their name as `claude --resume` lists it — your rename if you gave one, otherwise Claude's generated title — falling back to the first prompt for sessions too young to have one.
- **Status bar**: `⧉ Claude N` — click to focus the list.
- Optional **`C` badge** (always that one letter — just means "Claude touched this file", nothing else varies) on editor tabs / Explorer — off by default since the list below, the status bar, and CodeLenses already cover it; enable with `claudeEdits.showFileBadge`. **Known limitation:** VS Code has no reliable way to combine decorations from multiple extensions, so enabling this can intermittently replace git's own M/U/A letter instead of showing alongside it — leave it off if you rely on git's status letters.
- Changes to **Claude's own memory** (`~/.claude/…`) are listed even though they live outside your workspace; throwaway scratchpad files under `/tmp/claude-*` are hidden (both tunable via `claudeEdits.includeGlobs` / `excludeGlobs`).
- Optional: a **"Claude Edits"** section in the Source Control view plus quick-diff gutter markers — off by default, enable with `claudeEdits.scmView` (reload required).
- Works **retroactively** and in **any permission mode** — it reads the checkpoint snapshots Claude Code itself writes before every edit (`~/.claude/file-history/`), the same data the rewind feature uses.

## Reviewing

- **Only Claude's changes**: the session transcript's `Edit`/`Write` tool calls are replayed to reconstruct exactly what Claude wrote, so your own manual edits to the same files get **no Keep/Revert prompts**, and files where only your edits remain are hidden. If a transcript can't be replayed (e.g. you edited mid-session under Claude's feet), that file falls back to showing every change — it never hides Claude's work. Opt out with `claudeEdits.claudeOnly: false`.
- Each file shows **`+added −removed` line counts** for the changes under review.
- **Click a file** → native diff editor: accepted baseline vs current content.
- **Per file**: inline **Keep ✓** / **Undo ⟲** buttons (also per session, and Keep All / Undo All in the title bar).
- **Per individual change (hunk)**: CodeLens actions above every change, in the normal editor *and* the right side of the diff editor:
  - **✓ Keep this change** — the chunk is absorbed into your accepted baseline and disappears from the diff/gutter immediately. Review chunk by chunk; when you keep the last one, the file drops off the list entirely.
  - **↶ Revert** — puts the baseline content back for that chunk only (a normal edit; `Ctrl+Z` works).
  - After either action the cursor **jumps to the next remaining chunk**, so a file reviews end-to-end without manual scrolling.
  - The quick-diff gutter bars offer the same revert via the peek widget.

## Keep semantics ("accepted baseline")

Keeping (a hunk or a whole file) records the accepted content in a private **overlay** in extension storage — Claude Code's own checkpoint data is never modified. All diffs are *accepted baseline vs current*, so:

- a fully-kept file disappears everywhere;
- if Claude edits it again later, only the **new** delta shows;
- **Undo** restores the accepted baseline (not the pre-session content) once you've kept something — i.e. it undoes only what you haven't reviewed;
- overlays are garbage-collected after 30 days.

## Requirements & platform support

- Requires the **Claude Code VS Code extension** (`anthropic.claude-code`) — declared as an extension dependency; the "Changed Files" view mounts inside its sidebar container.
- For Keep/Revert lenses **inside diff editors**, `"diffEditor.codeLens": true` is required (VS Code default is off; lenses always show in normal editors). The extension offers to enable it on first activation — if you dismissed that prompt, flip the setting manually.
- Platforms: **WSL remote** (tested), **Linux**, **macOS**, **native Windows** (path casing/URI handling is win32-aware; not yet field-tested — report issues). `extensionKind: workspace` means it runs wherever your files/Claude Code live, including SSH remotes.
- On WSL, install from the WSL window so it lands server-side: `code --install-extension <vsix>` in the integrated terminal.

## Notes & limitations

- Edits made via Claude's `Edit`/`Write`/`NotebookEdit` tools are checkpointed by Claude Code itself and tracked exactly. Changes Claude makes through **Bash** (`sed -i`, redirects, heredocs, `tee`) aren't checkpointed by Claude Code at all. As a fallback, a file that `git status` shows as changed is attributed to a session when one of its Bash commands names the file (following `cd`, `~` and `$HOME`), or when the file was last modified while one of its Bash calls was running (calls over 60s don't count). The timing check catches any write style, including Python one-liners, `cp` and `$VAR` paths. Such changes surface unattributed: file-level diff only, no per-hunk Keep/Revert. Outside a git repo they still won't appear, nor will a Bash-written file you edited again afterwards unless the command named it. Renames show as deleted at the old path.
- "Undo" on a file you hand-edited after Claude rolls your edits back too — check the diff first.
- The list redraws on a short debounce (not instantly) while Claude is actively editing, to avoid flickering the panel on every single edit.
- Settings: `claudeEdits.lookbackHours` (48), `claudeEdits.maxSessions` (6), `claudeEdits.codeLens` (true), `claudeEdits.claudeOnly` (true), `claudeEdits.scmView` (false), `claudeEdits.showFileBadge` (false), `claudeEdits.includeGlobs` (`["**/.claude/**"]`), `claudeEdits.excludeGlobs` (`["/tmp/claude-*/**"]`).
- Data format is Claude Code internal (verified on 2.1.220 and 2.1.24x); a future Claude Code release could change it. 2.1.221+ added an undocumented, staged-rollout "bashFirst" system-prompt addition that steers `auto`/`bypassPermissions` sessions toward Bash over `Edit`/`Write` — see the Bash fallback above and [issue #1](https://github.com/Danielfarkashh/claude-edits-scm/issues/1).

## Download & install

**From the Marketplace:** search "Claude Edits" in VS Code's Extensions view, or [install directly](https://marketplace.visualstudio.com/items?itemName=dfarkash.claude-edits-scm).

**From a release** (e.g. to pin a specific version): grab the `.vsix` from the [latest release](https://github.com/Danielfarkashh/claude-edits-scm/releases/latest), then:

```bash
code --install-extension claude-edits-scm-<version>.vsix
```

then **Developer: Reload Window**. In a WSL window run this in the integrated terminal so it installs on the WSL (server) side; on native Windows/macOS run it anywhere. You can also install via the Extensions view → `…` menu → **Install from VSIX**.

PRs and issues welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Dev

Plain JavaScript, no build step. `npm test` (or `node test-hunks.js`, `node test-attrib.js <workspaceRoot>`, etc. individually) runs the property-test suites; most also exercise real `~/.claude` data when a workspace root is passed, so results vary by machine — that's expected. CI (GitHub Actions, `.github/workflows/ci.yml`) runs the pure property tests on every push/PR. Package with `npx @vscode/vsce package`; tagging a release (`vX.Y.Z`) triggers `.github/workflows/release.yml` to build the vsix and attach it to a GitHub Release.
