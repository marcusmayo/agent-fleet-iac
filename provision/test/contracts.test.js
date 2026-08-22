'use strict';
// Every agent contract belongs in git. A contract carries a name, a profile, a domain, a region
// and a size -- no content, no credential, and no pointer to either -- so publishing one exposes
// topology, not data, while making a teardown recoverable from the repo instead of from whichever
// workstation happens to still have the file. Heimdall's lived only on one machine and every
// block in a long session carried it as known dirt; this test is what would have said so.
//
// The exception the .gitignore still covers is agents/*.local.jsonc, which is where an sshCidr
// (a home /32) goes. That is the one field in a contract worth keeping out of a public repo.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENTS = path.join(ROOT, 'agents');
const inGit = fs.existsSync(path.join(ROOT, '.git'));
const skip = inGit ? false : 'not a git checkout';

function tracked() {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
}
const contracts = () => (fs.existsSync(AGENTS) ? fs.readdirSync(AGENTS) : [])
  .filter((n) => n.endsWith('.jsonc') && !n.endsWith('.local.jsonc'));

test('every contract on disk is tracked -- a teardown must survive the loss of a laptop', { skip }, () => {
  const t = tracked();
  const missing = contracts().map((n) => 'agents/' + n).filter((p) => !t.includes(p));
  assert.deepStrictEqual(missing, [], 'contract(s) on disk but not in git:\n  ' + missing.join('\n  '));
});

test('a local override contract stays OUT of git -- that is where an sshCidr lives', { skip }, () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /agents\/\*\.local\.jsonc/);
  assert.ok(!tracked().some((p) => p.endsWith('.local.jsonc')), 'a .local.jsonc is tracked');
});

test('a contract carries topology only -- no secret ever rides in one', () => {
  const banned = /(secret|password|token|key|clientSecret|apiKey)/i;
  for (const n of contracts()) {
    const raw = fs.readFileSync(path.join(AGENTS, n), 'utf8');
    const keys = [...raw.matchAll(/"([A-Za-z0-9_]+)"\s*:/g)].map((m) => m[1]);
    const bad = keys.filter((k) => banned.test(k));
    assert.deepStrictEqual(bad, [], n + ' carries a secret-shaped field: ' + bad.join(', '));
  }
});
