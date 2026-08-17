'use strict';
// The repo gate proves, before a VM is paid for, that the agent repo at the contract's ref would
// pass its own build-time drift check. These tests build a throwaway "remote" agent repo on disk
// (git init, one stamped vendored dir) so they run offline on any machine with git.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const rg = require('../lib/repogate');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// A minimal fleet-agent-shaped repo: scripts/ with two vendored files and a stamp whose manifest
// hashes them (LF bytes, like sync-core writes). Returns { dir, sha } of its single commit.
function makeAgentRepo(root, { tamperAfterStamp = false, noStamp = false } = {}) {
  const dir = path.join(root, 'agent-remote');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const a = "'use strict';\nmodule.exports = 1;\n", b = "#!/usr/bin/env bash\necho hi\n";
  fs.writeFileSync(path.join(dir, 'scripts', 'a.js'), a);
  fs.writeFileSync(path.join(dir, 'scripts', 'fetch-secret.sh'), b);
  if (!noStamp) {
    fs.writeFileSync(path.join(dir, 'scripts', '.fleet-core-version'),
      `# fleet-core sync stamp -- do not edit by hand\nfleet_core_commit: abc1234\nsynced_at: 2026-08-17T00:00:00Z\nmanifest:\n  ${sha(a)}  a.js\n  ${sha(b)}  fetch-secret.sh\n`);
  }
  if (tamperAfterStamp) fs.appendFileSync(path.join(dir, 'scripts', 'a.js'), '// drift\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'agent');
  return { dir, sha: git(dir, 'rev-parse', '--short', 'HEAD').trim() };
}

test('a stamped repo whose files match its manifest PASSES, naming the stamp dirs and file count', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repogate-t-'));
  const { dir, sha: head } = makeAgentRepo(tmp);
  const r = rg.checkRepoGate({ repoUrl: dir, ref: '' });
  assert.strictEqual(r.ok, true, r.detail);
  assert.match(r.detail, /1 stamp \(scripts\), 2 files match/);
  assert.strictEqual(r.sha, head);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a vendored file changed after the stamp FAILS and names the file (the failure that shipped)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repogate-t-'));
  const { dir } = makeAgentRepo(tmp, { tamperAfterStamp: true });
  const r = rg.checkRepoGate({ repoUrl: dir, ref: '' });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /would FAIL its image build: scripts: a\.js: hash differs/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a repo with no stamp is not a fleet agent: FAIL, fail-closed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repogate-t-'));
  const { dir } = makeAgentRepo(tmp, { noStamp: true });
  const r = rg.checkRepoGate({ repoUrl: dir, ref: '' });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /carries no \.fleet-core-version stamp/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a ref that does not exist is a clone error, not a pass', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repogate-t-'));
  const { dir } = makeAgentRepo(tmp);
  const r = rg.checkRepoGate({ repoUrl: dir, ref: 'no-such-branch' });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /could not clone/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a commit sha ref resolves the way cloud-init resolves it (clone, then checkout)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repogate-t-'));
  const { dir, sha: head } = makeAgentRepo(tmp);
  const r = rg.checkRepoGate({ repoUrl: dir, ref: head });
  assert.strictEqual(r.ok, true, r.detail);
  assert.strictEqual(r.sha, head);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hashes are over the bytes git ships (LF), so a CRLF-ified copy would not pass -- the check is byte-exact like verify-core.sh', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repogate-t-'));
  const dir = path.join(tmp, 'w'); fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const a = "line\n";
  fs.writeFileSync(path.join(dir, 'scripts', 'a.js'), a.replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(dir, 'scripts', '.fleet-core-version'), `manifest:\n  ${sha(a)}  a.js\n`);
  const v = rg.verifyTree(dir);
  assert.strictEqual(v.ok, false);
  assert.match(v.stamps[0].failed[0], /a\.js: hash differs/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
