'use strict';
// win32 case-handling checks, runnable on any OS by mocking process.platform.
// Note: path.dirname stays POSIX here, so the ancestor walk is exercised for
// real only on Windows — these tests cover the case-insensitive matching core.
const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32' });
delete require.cache[require.resolve('./lib')];
const lib = require('./lib');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

// VS Code gives lowercase drive; Claude Code recorded uppercase.
const projectDirs = ['C--Users-jane-proj', 'C--Users-jane', 'D--other'];
const matched = lib.matchProjectDirs(projectDirs, ['c:\\Users\\jane\\proj']);
assert(matched.includes('C--Users-jane-proj'), `own dir matched case-insensitively (got ${JSON.stringify(matched)})`);

// subdirectory sessions: dirs that extend the workspace's sanitized name
const matched2 = lib.matchProjectDirs(['C--Users-jane-proj-sub'], ['c:\\Users\\jane\\proj']);
assert(matched2.includes('C--Users-jane-proj-sub'), 'subdir project dir matched case-insensitively');

// overlay hashing must canonicalize casing so writer/reader agree
const a = lib.overlayPathFor('/o', 'C:\\Users\\jane\\proj\\F.TS');
const b = lib.overlayPathFor('/o', 'c:\\users\\jane\\proj\\f.ts');
assert(a === b, 'overlay path is casing-independent on win32');

Object.defineProperty(process, 'platform', { value: realPlatform });
delete require.cache[require.resolve('./lib')];
console.log('OK: win32 case-handling checks passed');
