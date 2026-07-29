# Contributing

Thanks for considering a contribution — this started as a personal itch-scratch and grew via real bug reports, so practical fixes and honest edge-case reports are exactly what it needs.

## Setup

No build step — plain JavaScript, install with `npm install` (dev-only dependency: `@vscode/vsce` for packaging). Load the folder with **Run Extension** in VS Code's debug view (`F5`), or package and install a `.vsix` locally:

```bash
npx @vscode/vsce package --allow-missing-repository
code --install-extension claude-edits-scm-<version>.vsix
```

## Project layout

- `lib.js` — the data/logic layer: reads Claude Code's checkpoint data, the line-diff engine, and the Claude-vs-user attribution engine. No `vscode` import, so it's runnable and testable in plain Node.
- `extension.js` — VS Code wiring: views, commands, CodeLens, the SCM provider.
- `cli.js` — a headless twin of the pipeline (`node cli.js changes <root>`), useful for debugging without VS Code.
- `test-*.js` — see below.

## Tests

Each `test-*.js` is a standalone script (no test runner) — run directly with `node`:

- `test-hunks.js` — randomized property tests of the diff engine (pure, no external data).
- `test-attrib.js` — the Claude-vs-user attribution engine; a mix of hand-built scenarios and 2000+ randomized ones. This is the one most bugs have hidden in — attribution is inherently subtle (see the commit history for the string of real-world failure modes it evolved through).
- `test-title.js`, `test-delta.js`, `test-win32.js` — targeted regressions for specific Claude Code transcript formats and Windows path handling.
- `test.js`, `test-overlay.js`, `test-e2e.js` — these read your **real** `~/.claude` data (or, for `test-e2e.js`, spawn a real `claude -p` session) and are excluded from CI for that reason; run them locally when touching the data layer.

`.github/workflows/ci.yml` runs the pure suites on every push/PR.

## Reporting bugs

The most valuable bug report for this project is a **concrete repro**: what you did (edit, keep, revert, in what order), what you expected, and what happened. Attribution and diff-engine bugs are almost always order-of-operations issues that are hard to guess from a description alone but easy to turn into a test once reproduced.

## Filing a PR

Keep the no-build-step, no-dependencies philosophy where practical — it keeps the barrier to contributing low and the surface area small. Add a test for behavior changes; `test-attrib.js` and `test-hunks.js` are good models for how to write a new one.
