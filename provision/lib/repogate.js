'use strict';
// repogate.js -- before a VM is paid for, prove the agent repo at the contract's ref would pass its
// own drift gate. Every fleet agent vendors fleet-core with a .fleet-core-version stamp beside the
// files, and its Dockerfile runs verify-core.sh against each vendored dir: a stamp that disagrees
// with its files fails the image build INSIDE the VM, where the provisioning lane cannot see it.
// That happened once -- the stamp named the pre-accent webchat-controls.js beside the accent
// version, the build died on the VM and a fresh agent sat at 502 while `up` reported success.
//
// The lane now clones the repo at the ref (shallow; LF checkout regardless of platform, because
// verify-core hashes bytes and git on Windows would otherwise CRLF-ify them) and runs the same
// hash check verify-core.sh runs, in Node: plan says PASS/FAIL naming the files, --go refuses a
// repo that cannot build. No bash, no sha256sum, no network beyond the clone -- works on the
// workstation and on the plane. Fail-closed: a repo with no stamp is not a fleet agent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { runCapture } = require('./util');

const SHA_RE = /^[0-9a-f]{7,40}$/;

function walkStamps(root, out = []) {
  for (const n of fs.readdirSync(root)) {
    if (n === '.git' || n === 'node_modules') continue;
    const p = path.join(root, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walkStamps(p, out);
    else if (n === '.fleet-core-version') out.push(root);
  }
  return out;
}

// The stamp's manifest lines: "<sha256>  <name>" under a "manifest:" header (see sync-core.sh).
function readStamp(dir) {
  const text = fs.readFileSync(path.join(dir, '.fleet-core-version'), 'utf8').replace(/\r/g, '');
  const commit = (text.match(/^fleet_core_commit:\s*(\S+)/m) || [])[1] || '';
  const entries = [];
  let inManifest = false;
  for (const line of text.split('\n')) {
    if (/^manifest:/.test(line)) { inManifest = true; continue; }
    if (!inManifest) continue;
    const m = line.match(/^\s+([0-9a-f]{64})\s+(\S+)\s*$/);
    if (m) entries.push({ hash: m[1], name: m[2] });
    else if (line.trim() !== '') break;
  }
  return { commit, entries };
}

function verifyDir(dir, root) {
  const { commit, entries } = readStamp(dir);
  const failed = [];
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (!fs.existsSync(f)) { failed.push(`${e.name}: listed in the stamp, not in the repo`); continue; }
    const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (h !== e.hash) failed.push(`${e.name}: hash differs from the stamp (the file changed, the manifest did not)`);
  }
  if (!entries.length) failed.push('stamp has no manifest lines');
  return { dir: path.relative(root, dir).split(path.sep).join('/') || '.', commit, checked: entries.length, failed };
}

function verifyTree(root) {
  const dirs = walkStamps(root);
  const stamps = dirs.map((d) => verifyDir(d, root));
  const failed = stamps.reduce((n, s) => n + s.failed.length, 0);
  return { ok: dirs.length > 0 && failed === 0, stamps, failed, noStamps: dirs.length === 0 };
}

// Clone at the ref exactly the way cloud-init does (clone, then checkout the ref), with an LF
// checkout whatever the platform's autocrlf says. A branch or tag clones shallow with --branch; a
// commit sha (which --branch cannot take, and which a hosted remote will not serve shallow when
// abbreviated) clones the history and checks the sha out. Returns { ok, sha, error }.
function cloneAt(repoUrl, ref, dest) {
  const base = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'advice.detachedHead=false'];
  const isSha = ref && SHA_RE.test(ref);
  let r = runCapture('git', [...base, 'clone', '-q', ...(isSha ? [] : ['--depth', '1']), ...(ref && !isSha ? ['--branch', ref] : []), repoUrl, dest]);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'git clone failed').split('\n').filter(Boolean).slice(-1)[0] };
  if (isSha) {
    r = runCapture('git', ['-C', dest, ...base, 'checkout', '-q', ref]);
    if (!r.ok) return { ok: false, error: `ref ${ref} did not resolve in ${repoUrl}: ` + (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] };
  }
  const sha = runCapture('git', ['-C', dest, 'rev-parse', '--short', 'HEAD']);
  return { ok: true, sha: sha.ok ? sha.stdout.trim() : '?' };
}

// -> { ok, detail, sha, stamps, failed }   never throws
function checkRepoGate({ repoUrl, ref }) {
  if (!repoUrl) return { ok: false, detail: 'no repoUrl resolved for this contract', sha: '', stamps: [], failed: 0 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repogate-'));
  try {
    const cl = cloneAt(repoUrl, (ref || '').trim(), tmp);
    if (!cl.ok) return { ok: false, detail: `could not clone ${repoUrl}${ref ? ' @ ' + ref : ''}: ${cl.error}`, sha: '', stamps: [], failed: 0 };
    const v = verifyTree(tmp);
    const repoName = repoUrl.replace(/\.git$/, '').split('/').slice(-1)[0];
    if (v.noStamps) return { ok: false, detail: `${repoName} @ ${cl.sha} carries no .fleet-core-version stamp -- not a fleet agent repo`, sha: cl.sha, stamps: [], failed: 0 };
    const files = v.stamps.reduce((n, s) => n + s.checked, 0);
    const detail = v.ok
      ? `${repoName} @ ${cl.sha} -- ${v.stamps.length} stamp${v.stamps.length === 1 ? '' : 's'} (${v.stamps.map((s) => s.dir).join(', ')}), ${files} files match`
      : `${repoName} @ ${cl.sha} would FAIL its image build: ` + v.stamps.filter((s) => s.failed.length).map((s) => s.dir + ': ' + s.failed.join('; ')).join(' | ');
    return { ok: v.ok, detail, sha: cl.sha, stamps: v.stamps, failed: v.failed };
  } catch (e) {
    return { ok: false, detail: 'repo gate errored: ' + (e && e.message ? e.message : String(e)), sha: '', stamps: [], failed: 0 };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

module.exports = { checkRepoGate, verifyTree, verifyDir, readStamp, cloneAt, walkStamps };
