'use strict';
// The control plane's language is for a stranger: shipped code, scripts, templates and docs
// must not name live agents (they leak fleet topology from public repos, and a panel that
// says "e.g. bosun" reads as one operator's notes). Test fixtures and contracts are data,
// not language, and are excluded. Add a name here the day it becomes a live agent.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIVE = /\b(bosun|heimdall)\b/i;
const ROOT = path.resolve(__dirname, '..', '..');
const SCAN = ['provision/lib', 'provision/bin', 'scripts', 'core', 'bicep', 'README.md', 'provision/README.md'];
const EXT = new Set(['.js', '.sh', '.ps1', '.bicep', '.bicepparam', '.yaml', '.yml', '.md', '.jsonc', '.json']);

function walk(p, out) {
  if (!fs.existsSync(p)) return out;
  const st = fs.statSync(p);
  if (st.isFile()) { if (EXT.has(path.extname(p))) out.push(p); return out; }
  for (const n of fs.readdirSync(p)) { if (n === 'node_modules' || n.startsWith('.')) continue; walk(path.join(p, n), out); }
  return out;
}

// "Shipped" means what git ships: tracked files plus untracked ones git would not ignore. A
// gitignored build artifact (a stale bicep/main.json compiled long ago on one workstation) is
// not shipped and must not fail the guard -- but a fresh edit that is not committed yet must.
// Falls back to a plain directory walk when git is not available (a tarball checkout).
function shipped(rels) {
  try {
    const out = require('node:child_process').execFileSync('git',
      ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...rels],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean).map((r) => path.join(ROOT, r))
      .filter((f) => EXT.has(path.extname(f)) && fs.existsSync(f) && fs.statSync(f).isFile()
        && !f.split(path.sep).some((seg) => seg === 'node_modules' || (seg.startsWith('.') && seg !== '.')));
  } catch {
    const out = [];
    for (const rel of rels) walk(path.join(ROOT, rel), out);
    return out;
  }
}

test('no live agent names in shipped code, scripts, templates or docs', () => {
  const hits = [];
  for (const f of shipped(SCAN)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => { if (LIVE.test(l)) hits.push(path.relative(ROOT, f) + ':' + (i + 1) + ': ' + l.trim().slice(0, 100)); });
  }
  assert.deepStrictEqual(hits, [], 'live agent names found:\n  ' + hits.join('\n  '));
});
