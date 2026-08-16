'use strict';
// migrate.js — move an agent's durable data to another agent, mediated by the control plane.
//
// This is deferred item #2 (cross-agent restore), and the hosted control plane changed the
// answer. The blockers were real: each agent's identity can read only its OWN backup
// container, and a snapshot's members are absolute source paths
// (var/lib/docker/volumes/<profile>_<profile>-<vol>/_data/...). Granting agents read on
// each other's stores would have traded a real isolation for convenience. Instead the
// PLANE -- which already holds the privilege -- makes the one hop, attested and ledgered:
//
//   1. fresh snapshot of <from> (agent-backup push, its own identity, its own container)
//   2. plane downloads it, reads the member list + the source audit chain head, hashes it
//   3. plane uploads it UNCHANGED into <to>'s container as migrate-<from>-<stamp>.tar.gz
//   4. <to> fetches it with its OWN identity (same path agent-backup restore uses) and
//      extracts ONLY the scoped members, translating the volume prefix
//      (keel_keel-knowledge -> castor_castor-knowledge), then restarts its webchat
//   5. the ledger records from/to, scope, both blob names, sha256, member count, and the
//      source chain's head (seq + hash) -- the cross-anchor. Chains themselves NEVER move.
//
// Nothing per-profile is hardcoded: source volumes come from the source (docker volume ls),
// target volumes from the target, both app users are the same uid (10001) so ownership
// survives, and the compose project is the profile so every agent of a profile shares one
// volume naming. Scope legality (pure, tested):
//   same profile   -> everything but logs (default: all of that)
//   cross profile  -> volumes BOTH sides have, minus logs and state; default knowledge;
//                     claude (transcripts + state/chat-session*.json pointers) opt-in
//   logs           -> never. A chain that moves is a chain that lies.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { c: col, runCapture, which } = require('./util');
const bk = require('./backup');
const { agentIdentity } = require('./enroll');
const { resolvePolicyPath, ledger } = require('./policy');

const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const NEVER = new Set(['logs']);
const CROSS_NEVER = new Set(['logs', 'state']);
const CROSS_DEFAULT = ['knowledge'];
const VOLROOT = 'var/lib/docker/volumes/';

function attestSentence(from, to) { return 'I approve migrating ' + from + ' to ' + to; }

// Pure: <profile>_<profile>-<vol> -> vol suffix, for the given profile only.
function volSuffixes(volumeNames, profile) {
  const pre = profile + '_' + profile + '-';
  return (volumeNames || []).filter((v) => typeof v === 'string' && v.startsWith(pre)).map((v) => v.slice(pre.length)).filter(Boolean).sort();
}

// Pure: what may move between these two profiles, what moves by default, and whether the
// request is legal. requested: array of suffixes or null (defaults).
function resolveScope(fromProfile, toProfile, sourceSuffixes, targetSuffixes, requested) {
  const src = new Set(sourceSuffixes || []);
  const tgt = new Set(targetSuffixes || []);
  const same = fromProfile === toProfile;
  const never = same ? NEVER : CROSS_NEVER;
  const allowed = [...src].filter((v) => tgt.has(v) && !never.has(v)).sort();
  const dflt = same ? allowed : CROSS_DEFAULT.filter((v) => allowed.includes(v));
  const want = (requested && requested.length ? requested : dflt).map((s) => String(s).trim()).filter(Boolean);
  const illegal = want.filter((v) => !allowed.includes(v));
  if (!want.length) return { ok: false, allowed, scope: [], why: 'nothing to migrate: no volume both agents share is allowed for ' + (same ? 'this profile' : 'a cross-profile move') };
  if (illegal.length) {
    return { ok: false, allowed, scope: want, why: 'scope not allowed for ' + fromProfile + '->' + toProfile + ': ' + illegal.join(', ') + ' (allowed: ' + (allowed.join(', ') || 'none') + ')' };
  }
  return { ok: true, allowed, scope: want, same };
}

// Pure: tar member patterns for a scope. claude brings its session pointers from state.
function memberPatterns(fromProfile, scope) {
  const pre = VOLROOT + fromProfile + '_' + fromProfile + '-';
  const pats = scope.map((v) => pre + v + '/_data*');
  // Pointers ride along with claude -- unless state moves whole, in which case they are
  // already inside it: GNU tar treats a pattern that matches only already-taken members as
  // "Not found in archive" and exits 2. (Found by executing the generated script for real.)
  if (scope.includes('claude') && !scope.includes('state')) pats.push(pre + 'state/_data/chat-session*.json');
  return pats;
}
function transformExpr(fromProfile, toProfile) {
  return 's#^' + VOLROOT + fromProfile + '_' + fromProfile + '-#' + VOLROOT + toProfile + '_' + toProfile + '-#';
}
// Pure: the script the TARGET runs. Fetches with ITS identity from ITS container (the same
// path agent-backup restore uses), asserts every target volume exists before touching
// anything, extracts only the scoped members with the prefix translated, restarts webchat.
function targetScript({ account, to, blob, fromProfile, toProfile, scope }) {
  const vols = scope.map((v) => toProfile + '_' + toProfile + '-' + v);
  if (scope.includes('claude') && !scope.includes('state')) vols.push(toProfile + '_' + toProfile + '-state');
  const pats = memberPatterns(fromProfile, scope).map((p) => "'" + p + "'").join(' ');
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'ACC=' + account + '; CT=' + to + '; BLOB=' + blob,
    'tok() { curl -fsS --get -H Metadata:true --data-urlencode "api-version=2018-02-01" --data-urlencode "resource=https://storage.azure.com/" "http://169.254.169.254/metadata/identity/oauth2/token" | grep -o \'"access_token":"[^"]*\' | cut -d\'"\' -f4; }',
    'T="$(tok)"; TMP="/tmp/$BLOB"',
    'curl -fsS -H "Authorization: Bearer $T" -H "x-ms-version: 2021-08-06" -o "$TMP" "https://$ACC.blob.core.windows.net/$CT/$BLOB"',
    'echo "fetched-sha256: $(sha256sum "$TMP" | cut -d\' \' -f1)"',
    'for v in ' + [...new Set(vols)].join(' ') + '; do [ -d "/var/lib/docker/volumes/$v/_data" ] || { echo "ABORT: target volume $v missing"; rm -f "$TMP"; exit 1; }; done',
    'N=$(tar -tzf "$TMP" --wildcards ' + pats + ' | wc -l)',
    'tar -xzf "$TMP" -C / --wildcards --transform \'' + transformExpr(fromProfile, toProfile) + '\' ' + pats,
    'rm -f "$TMP"',
    'echo "extracted: $N members"',
    'for ct in $(docker ps --format \'{{.Names}}\' | grep -- \'-webchat$\'); do docker restart "$ct" >/dev/null && echo "restarted: $ct"; done',
    'echo "migrated: $BLOB"',
  ].join('\n') + '\n';
}

// ---- Azure reads (thin) ----------------------------------------------------------------
const az = (args, opts) => runCapture('az', args, opts);
function rgTags(name) {
  const r = az(['group', 'show', '-n', 'rg-' + name, '-o', 'json']);
  if (!r.ok) return { ok: false, why: 'rg-' + name + ' unreadable: ' + ((r.stderr || 'az group show failed').split('\n')[0]) };
  try { return agentIdentity(JSON.parse(r.stdout || '{}').tags, name); } catch { return { ok: false, why: 'rg-' + name + ' unreadable (bad json)' }; }
}
function vmRunning(name) {
  const r = az(['vm', 'get-instance-view', '-g', 'rg-' + name, '-n', name + '-vm', '--query', 'instanceView.statuses', '-o', 'json']);
  if (!r.ok) return { ok: false, why: ((r.stderr || 'az vm get-instance-view failed').split('\n')[0]) };
  try {
    const st = JSON.parse(r.stdout || '[]');
    const p = st.find((s) => s && typeof s.code === 'string' && s.code.startsWith('PowerState/'));
    return { ok: !!p && p.code === 'PowerState/running', state: p ? p.code.slice('PowerState/'.length) : 'unknown' };
  } catch { return { ok: false, why: 'unreadable instance view' }; }
}
function runOnVm(name, script) {
  const f = path.join(os.tmpdir(), 'fleet-migrate-' + name + '-' + Date.now().toString(36) + '.sh');
  fs.writeFileSync(f, script, 'utf8');
  try {
    const r = az(['vm', 'run-command', 'invoke', '-g', 'rg-' + name, '-n', name + '-vm', '--command-id', 'RunShellScript', '--scripts', '@' + f, '-o', 'json'], { maxBuffer: 16 * 1024 * 1024 });
    let msg = '';
    try { msg = (JSON.parse(r.stdout || '{}').value || []).map((v) => v.message || '').join('\n'); } catch { msg = r.stdout || ''; }
    return { ok: r.ok, msg, err: r.ok ? '' : ((r.stderr || r.stdout || 'run-command failed').split('\n')[0]) };
  } finally { try { fs.unlinkSync(f); } catch { /* best effort */ } }
}
function dockerVolumes(name) {
  const r = runOnVm(name, "#!/bin/bash\ndocker volume ls --format '{{.Name}}'\n");
  if (!r.ok) return null;
  const m = r.msg.match(/\[stdout\]\n([\s\S]*?)\n\[stderr\]/);
  const body = m ? m[1] : r.msg;
  return body.split('\n').map((s) => s.trim()).filter((s) => /^[a-z0-9][a-z0-9_-]*$/i.test(s));
}
function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function tarList(f) {
  const r = runCapture('tar', ['-tzf', f], { maxBuffer: 64 * 1024 * 1024 });
  return r.ok ? (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean) : null;
}
function chainHead(f, fromProfile) {
  const r = runCapture('tar', ['-xzOf', f, VOLROOT + fromProfile + '_' + fromProfile + '-logs/_data/audit.jsonl'], { maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok) return null;
  const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!last) return null;
  try { const j = JSON.parse(last); return { seq: j.seq === undefined ? null : j.seq, hash: j.hash || null }; } catch { return null; }
}

// ---- lane ------------------------------------------------------------------------------
async function runMigrate(from, to, opts = {}) {
  console.log(col.cyan('migrate ' + (from || '?') + ' -> ' + (to || '?') + (opts.go ? ' --go' : ' (plan)')));
  if (!from || !to || !NAME_RE.test(from) || !NAME_RE.test(to)) { console.log(col.red('\nmigrate: usage — fleetctl migrate <from> <to> [--scope=a,b] [--blob=<name>] [--go --attest "..."]')); return 2; }
  if (from === to) { console.log(col.red('\nmigrate: from and to are the same agent')); return 2; }
  const requested = opts.scope ? String(opts.scope).split(',').map((s) => s.trim()).filter(Boolean) : null;

  // ---- gather ----
  const R = { az: which('az'), tar: which('tar'), account: bk.resolveAccount() };
  R.fromId = rgTags(from); R.toId = rgTags(to);
  R.toVm = vmRunning(to); R.fromVm = vmRunning(from);
  R.blobs = R.account ? (bk.listBlobs(from, R.account) || null) : null;
  R.srcVols = R.fromVm.ok ? dockerVolumes(from) : null;
  R.tgtVols = R.toVm.ok ? dockerVolumes(to) : null;
  const fp = R.fromId.ok ? R.fromId.profile : '', tp = R.toId.ok ? R.toId.profile : '';
  R.srcSuf = fp && R.srcVols ? volSuffixes(R.srcVols, fp) : [];
  R.tgtSuf = tp && R.tgtVols ? volSuffixes(R.tgtVols, tp) : [];
  R.scope = (fp && tp) ? resolveScope(fp, tp, R.srcSuf, R.tgtSuf, requested) : { ok: false, allowed: [], scope: [], why: 'profiles unknown' };
  const required = attestSentence(from, to);

  // ---- plan ----
  console.log(col.bold('\nMIGRATE — ' + from + '  ->  ' + to));
  console.log('  source          ' + (R.fromId.ok ? col.green('rg-' + from + '  profile ' + fp) : col.red('REFUSED: ' + R.fromId.why)) + col.dim('   vm ' + (R.fromVm.ok ? 'running' : (R.fromVm.state || R.fromVm.why || 'unknown'))));
  console.log('  target          ' + (R.toId.ok ? col.green('rg-' + to + '  profile ' + tp) : col.red('REFUSED: ' + R.toId.why)) + col.dim('   vm ' + (R.toVm.ok ? 'running' : (R.toVm.state || R.toVm.why || 'unknown'))));
  console.log('  backup store    ' + (R.account ? R.account : col.red('absent — run fleetctl backup init')) + col.dim(R.blobs ? '   ' + R.blobs.length + ' snapshot(s) of ' + from + (R.blobs.length ? ', latest ' + R.blobs[R.blobs.length - 1] : '') : '   (snapshots unreadable)'));
  console.log('  source volumes  ' + (R.srcSuf.length ? R.srcSuf.join(', ') : col.yellow('unread (source VM must be running)')));
  console.log('  target volumes  ' + (R.tgtSuf.length ? R.tgtSuf.join(', ') : col.yellow('unread (target VM must be running)')));
  console.log('  scope           ' + (R.scope.ok ? col.green(R.scope.scope.join(', ')) + col.dim(R.scope.scope.includes('claude') ? '  (+ state/chat-session*.json pointers)' : '') : col.red(R.scope.why || 'unresolved')) + col.dim('   allowed: ' + (R.scope.allowed.length ? R.scope.allowed.join(', ') : 'none') + ' · logs never move'));
  console.log('  snapshot        ' + (opts.blob ? 'existing ' + opts.blob : 'FRESH (agent-backup push on ' + from + ' first)') + col.dim('  -> copied unchanged into ' + to + '\'s container as migrate-' + from + '-<stamp>.tar.gz'));
  console.log('  attestation     ' + col.dim(required));
  if (!opts.go) { console.log(col.yellow('\nplan only — nothing was moved. Re-run with --go --attest "' + required + '" to execute.')); return 0; }

  // ---- go ----
  const policyPath = resolvePolicyPath();
  const base = { action: 'aegis.migrate', key: from + '>' + to, from, to, fromProfile: fp || null, toProfile: tp || null, scope: R.scope.scope };
  const led = (extra) => { try { return policyPath ? ledger(policyPath, { ...base, ...extra }) : null; } catch { return null; } };
  if ((opts.attest || '').trim() !== required) {
    led({ phrase: opts.attest || '', outcome: 'refused: attestation mismatch' });
    console.log(col.red('\nmigrate --go REFUSED — attestation must read exactly:')); console.log('  ' + required); return 3;
  }
  const refuse = (why) => { led({ phrase: opts.attest, outcome: 'refused: ' + why }); console.log(col.red('\nmigrate --go REFUSED (nothing moved) — ' + why)); return 2; };
  if (!R.az) return refuse('az not found');
  if (!R.tar) return refuse('tar not found on this host');
  if (!R.fromId.ok) return refuse(R.fromId.why);
  if (!R.toId.ok) return refuse(R.toId.why);
  if (!R.account) return refuse('backup store absent (fleetctl backup init)');
  if (!R.toVm.ok) return refuse('target VM not running (' + (R.toVm.state || R.toVm.why) + ')');
  if (!opts.blob && !R.fromVm.ok) return refuse('source VM not running and no --blob given');
  if (!R.scope.ok) return refuse(R.scope.why);
  if (opts.blob && !/^[A-Za-z0-9._-]{1,200}$/.test(opts.blob)) return refuse('--blob fails safe charset');
  if (opts.blob && R.blobs && !R.blobs.includes(opts.blob)) return refuse('--blob ' + opts.blob + ' is not a snapshot of ' + from);

  // 1. snapshot
  let srcBlob = opts.blob || '';
  if (!srcBlob) {
    console.log(col.cyan('\n[1/5] fresh snapshot of ' + from));
    const p = bk.triggerPush(from, 'push');
    const m = (p.stdout || '').match(/pushed:\s*([A-Za-z0-9._-]+\.tar\.gz)/);
    if (!p.ok || !m) { led({ phrase: opts.attest, outcome: 'failed: snapshot: ' + ((p.stderr || p.stdout || 'no output').split('\n').filter(Boolean)[0] || '').slice(0, 160) }); console.log(col.red('  snapshot FAILED (ledgered)')); return 1; }
    srcBlob = m[1]; console.log('  pushed ' + srcBlob);
  } else console.log(col.cyan('\n[1/5] using snapshot ' + srcBlob));

  // 2. download + inspect
  console.log(col.cyan('[2/5] plane reads the snapshot'));
  const tmp = path.join(os.tmpdir(), 'fleet-migrate-' + Date.now().toString(36) + '.tar.gz');
  const dl = az(['storage', 'blob', 'download', '--account-name', R.account, '-c', from, '-n', srcBlob, '-f', tmp, '--auth-mode', 'login', '--only-show-errors', '-o', 'none'], { maxBuffer: 16 * 1024 * 1024 });
  if (!dl.ok || !fs.existsSync(tmp)) { led({ phrase: opts.attest, sourceBlob: srcBlob, outcome: 'failed: download: ' + ((dl.stderr || 'az storage blob download failed').split('\n')[0]) }); console.log(col.red('  download FAILED (ledgered) — does the plane hold the backups grant? (fleetctl aegis grant … backups)')); return 1; }
  const sha = sha256File(tmp);
  const members = tarList(tmp);
  if (!members) { fs.unlinkSync(tmp); led({ phrase: opts.attest, sourceBlob: srcBlob, sha256: sha, outcome: 'failed: snapshot unreadable as tar.gz' }); console.log(col.red('  snapshot unreadable (ledgered)')); return 1; }
  const pats = memberPatterns(fp, R.scope.scope);
  const wanted = members.filter((n) => pats.some((p) => globLike(p, n)));
  const head = chainHead(tmp, fp);
  console.log('  ' + members.length + ' members, ' + wanted.length + ' in scope, sha256 ' + sha.slice(0, 16) + '…' + (head ? ', source chain head seq ' + head.seq + ' ' + String(head.hash || '').slice(0, 12) + '…' : ', source chain head unread'));
  if (!wanted.length) { fs.unlinkSync(tmp); led({ phrase: opts.attest, sourceBlob: srcBlob, sha256: sha, outcome: 'refused: snapshot has no members in scope' }); console.log(col.red('  nothing in scope inside the snapshot (ledgered)')); return 2; }

  // 3. upload into the target's container
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const migBlob = 'migrate-' + from + '-' + stamp + '.tar.gz';
  console.log(col.cyan('[3/5] plane hands it to ' + to + ' (' + migBlob + ' in ' + to + '\'s container)'));
  const ul = az(['storage', 'blob', 'upload', '--account-name', R.account, '-c', to, '-n', migBlob, '-f', tmp, '--auth-mode', 'login', '--only-show-errors', '-o', 'none'], { maxBuffer: 16 * 1024 * 1024 });
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  if (!ul.ok) { led({ phrase: opts.attest, sourceBlob: srcBlob, sha256: sha, outcome: 'failed: upload: ' + ((ul.stderr || 'az storage blob upload failed').split('\n')[0]) }); console.log(col.red('  upload FAILED (ledgered)')); return 1; }

  // 4. target extracts the scope with the prefix translated
  console.log(col.cyan('[4/5] ' + to + ' fetches with its own identity and extracts the scope'));
  const r = runOnVm(to, targetScript({ account: R.account, to, blob: migBlob, fromProfile: fp, toProfile: tp, scope: R.scope.scope }));
  const fetched = (r.msg.match(/fetched-sha256:\s*([0-9a-f]{64})/) || [])[1] || null;
  const extracted = (r.msg.match(/extracted:\s*(\d+) members/) || [])[1];
  const done = /migrated:/.test(r.msg);
  const restarted = (r.msg.match(/restarted:\s*(\S+)/g) || []).map((s) => s.replace(/restarted:\s*/, ''));
  if (!r.ok || !done) {
    const why = (r.msg.match(/ABORT: [^\n]*/) || [])[0] || r.err || (r.msg.split('\n').filter(Boolean).slice(-2).join(' | ')) || 'no output';
    led({ phrase: opts.attest, sourceBlob: srcBlob, migrateBlob: migBlob, sha256: sha, outcome: 'failed: target extract: ' + why.slice(0, 200) });
    console.log(col.red('  target extract FAILED (ledgered): ' + why.slice(0, 200))); return 1;
  }
  const integrity = fetched ? (fetched === sha ? 'sha256 verified end to end' : 'SHA MISMATCH ' + fetched.slice(0, 12)) : 'target sha unread';

  // 5. ledger
  console.log(col.cyan('[5/5] ledger'));
  const rec = led({ phrase: opts.attest, sourceBlob: srcBlob, migrateBlob: migBlob, sha256: sha, membersTotal: members.length, membersInScope: wanted.length, membersExtracted: extracted ? Number(extracted) : null, sourceChainHead: head, restarted, integrity, outcome: fetched && fetched !== sha ? 'ok (INTEGRITY MISMATCH — investigate)' : 'ok' });
  console.log(col.green('\nmigrated ' + from + ' -> ' + to + ': ' + R.scope.scope.join(', ') + ' — ' + (extracted || '?') + ' members, ' + integrity) + col.dim('  (ledgered ' + (rec ? 'ok' : 'NO') + ')'));
  if (head) console.log(col.dim('  cross-anchor: ' + from + ' chain head seq ' + head.seq + ' hash ' + head.hash + ' recorded with this migration; the chain itself stayed with ' + from));
  return 0;
}

// minimal glob for our two pattern shapes: trailing '*' (prefix) and 'chat-session*.json'
function globLike(pattern, name) {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

module.exports = { runMigrate, resolveScope, volSuffixes, memberPatterns, transformExpr, targetScript, attestSentence, globLike };
