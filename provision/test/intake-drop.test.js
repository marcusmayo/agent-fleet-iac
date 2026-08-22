'use strict';
// The intake on-ramp. Files an operator drops land in the agent's OWN container under intake/,
// and the agent's timer sweeps them into staging -- staging only, because Process is the
// operator's decision for a drop exactly as it is for a panel upload. Two things have to hold:
// a name can never collide (two screenshots called the same thing are two items), and the sweep
// script must be part of the vendored set, or agents would carry a manifest that does not
// describe what they hold and the next image build would fail on the drift check.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const bk = require('../lib/backup');

const CORE = path.resolve(__dirname, '..', '..', 'core');

test('a dropped file is stamped, so identical names are separate items', () => {
  const a = bk.intakeBlobName('/home/marcu/Screenshot.png', '2026-08-21T22-05-00Z');
  const b = bk.intakeBlobName('/home/marcu/other/Screenshot.png', '2026-08-21T22-06-00Z');
  assert.strictEqual(a, 'intake/2026-08-21T22-05-00Z-Screenshot.png');
  assert.notStrictEqual(a, b, 'same basename, different moment, different blob');
});

test('the blob always sits under intake/ and never escapes it', () => {
  for (const f of ['../../etc/passwd', '/etc/passwd', 'a/b/c.txt', 'plain.md']) {
    const n = bk.intakeBlobName(f, '2026-08-21T22-05-00Z');
    assert.ok(n.startsWith('intake/'), n);
    assert.strictEqual(n.split('/').length, 2, 'no nested path survives: ' + n);
  }
});

test('hostile characters in a filename are neutralised, not rejected silently', () => {
  const n = bk.intakeBlobName('note $(whoami); rm -rf.md', '2026-08-21T22-05-00Z');
  assert.ok(bk.safeBlobName(n), n);
  assert.ok(!/[$();]/.test(n), n);
});

test('a very long name is bounded', () => {
  const n = bk.intakeBlobName('x'.repeat(400) + '.png', '2026-08-21T22-05-00Z');
  assert.ok(n.length < 140, n.length);
  assert.ok(bk.safeBlobName(n));
});

test('the sweep script exists, is executable shell, and stages only', () => {
  const p = path.join(CORE, 'intake-sweep.sh');
  assert.ok(fs.existsSync(p), 'core/intake-sweep.sh must exist');
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /^#!\/usr\/bin\/env bash/, 'shebang');
  assert.match(src, /set -euo pipefail/, 'fails loudly');
  assert.ok(src.includes('staging'), 'it lands in staging');
  // the sweep must never reach into the profile pipeline itself -- that is Process
  assert.ok(!/inbox\/drop|exports\/inbound/.test(src), 'the sweep must not know any profile pipeline dir');
});

test('the sweep is in the vendored set in BOTH implementations, or the manifest lies', () => {
  const sync = fs.readFileSync(path.join(CORE, 'sync-core.sh'), 'utf8');
  assert.strictEqual(sync.split('intake-sweep.sh').length - 1, 2, 'both enumerations in sync-core.sh');
  const man = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core-manifest.js'), 'utf8');
  assert.ok(man.includes("'intake-sweep.sh'"), 'core-manifest.js must list it too');
  const manifest = fs.readFileSync(path.join(CORE, 'manifest.sha256'), 'utf8');
  assert.match(manifest, /\bintake-sweep\.sh$/m, 'the regenerated manifest must carry it');
});

test('cloud-init is parseable YAML -- a stray apostrophe inside a single-quoted runcmd is not', () => {
  const ci = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bicep', 'cloud-init', 'agent-cloudflared.yaml'), 'utf8');
  // Every runcmd entry is one single-quoted scalar. YAML ends such a scalar at the first
  // apostrophe, so `panel's` silently truncates the line and the rest becomes garbage: a comment
  // reading better cost a VM its overlay. Check the shape without pulling in a YAML dependency:
  // inside a '...' entry, an apostrophe must be doubled ('') or absent.
  const lines = ci.split('\n');
  const bad = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*-\s+'(.*)'\s*$/);
    if (!m) return;
    const body = m[1].split("''").join('');
    if (body.includes("'")) bad.push((i + 1) + ': ' + l.trim().slice(0, 90));
  });
  assert.deepStrictEqual(bad, [], 'unescaped apostrophe inside a single-quoted runcmd entry:\n  ' + bad.join('\n  '));
});

test('cloud-init sets the committer identity at birth, repo-local, from the deploy-time name', () => {
  const ci = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bicep', 'cloud-init', 'agent-cloudflared.yaml'), 'utf8');
  // Repo-local (.git/config): --global would live in a HOME that run-command shells do not
  // have, and --system would name every checkout on the box after one agent.
  assert.ok(ci.includes("config user.name '__AGENT_NAME__'"), 'name from the deploy-time placeholder');
  // one REAL address for every machine identity: per-machine addresses do not exist, and git
  // refuses an empty email -- which would be the original hostname-fallback-or-fail mode back
  assert.ok(ci.includes("config user.email 'keel@keel-pm.com'"), 'the fleet address, not an invented per-agent one');
  assert.ok(!ci.includes('__AGENT_NAME__@'), 'no fabricated per-agent address anywhere');
  assert.ok(!/config --global user\./.test(ci) && !/config --system user\./.test(ci), 'identity stays repo-local');
  const plane = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bicep', 'cloud-init', 'aegis-cloudflared.yaml'), 'utf8');
  assert.strictEqual(plane.split("config user.name 'aegis-vm'").length - 1, 2, 'both plane checkouts speak as the plane');
});

test('rebuild reads the committer identity back, so a checkout missing one is visible', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rebuild.js'), 'utf8');
  assert.match(src, /committer identity/);
  assert.match(src, /MISSING/, 'absence prints as MISSING rather than as silence');
});

test('cloud-init installs the sweep timer', () => {
  const ci = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bicep', 'cloud-init', 'agent-cloudflared.yaml'), 'utf8');
  assert.ok(ci.includes('agent-intake-sweep.timer'), 'timer unit');
  assert.ok(ci.includes('agent-intake-sweep.service'), 'service unit');
  const b64 = (ci.match(/echo ([A-Za-z0-9+/=]{40,}) \| base64 -d > \/usr\/local\/bin\/agent-intake-sweep/) || [])[1];
  assert.ok(b64, 'the wrapper ships as base64, like the others');
  const wrapper = Buffer.from(b64, 'base64').toString('utf8');
  assert.match(wrapper, /intake-sweep\.sh/);
  assert.match(wrapper, /exit 0/, 'no-ops rather than failing on a profile that has not vendored it');
  // -f, never -x: vendored scripts are committed from Windows and land 100644 (backup-push.sh is
  // 644 today), so an -x guard would be false on every agent and the sweep would never run.
  assert.match(wrapper, /\[ -f /, 'the guard must test for the file, not the exec bit');
  assert.ok(!/\[ -x /.test(wrapper), 'an -x guard silently disables the sweep on every agent');
});
