'use strict';
// Fleet backup store -- one storage account in rg-fleet-backups, one container per
// agent, agents push nightly via MSI (core/backup-push.sh, installed by cloud-init).
// Everything here is workstation-side az; every step is idempotent or best-effort
// FAIL-LOUD-NON-BLOCKING. The store survives agent decommission by design.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { c, runCapture } = require('./util');

const BACKUP_RG = 'rg-fleet-backups';
const RETENTION_DAYS = 14;
// Three classes, one store, the same for every agent. Retention is a property of the
// CONTAINER, never of the agent, so a new agent inherits all three the day it exists and
// there is no per-agent policy to set or to forget.
//   <agent>/      operational spare parts -- the nightly machine-state tarball. Rebuildable,
//                 so it is the only class the delete rule touches (RETENTION_DAYS).
//   records/      the notebook: curated content an operator reads and acts on. NEVER deleted.
//                 records/data/  ages Hot -> Cool -> Archive on the shared schedule.
//                 records/index/ is the always-hot card catalogue -- no tier rule names it,
//                 so a year-old lookup is instant and only the objects it names rehydrate.
//   ledgers/      the receipts: hash chains proving a thing existed unaltered on a date.
//                 NEVER deleted, same ageing, plus a container immutability policy so a
//                 mis-scoped rule cannot reach them.
const LEDGERS = 'ledgers';
const RECORDS = 'records';
const RESERVED = [LEDGERS, RECORDS];
const COOL_DAYS = 30;
const ARCHIVE_DAYS = 180;      // six months: an ordinary half-year look-back never rehydrates
const IMMUTABLE_DAYS = 3650;   // ledgers: unlocked time-based retention (locking it is a one-way
                               // door and belongs to its own attested decision, not a build step)

// The lifecycle document, built from the operational container names. Pure: the only input is
// which containers hold spare parts. Azure filters are include-only -- there is no "exclude" --
// so the delete rule NAMES the containers it may empty and can reach nothing else by
// construction. The two permanent classes carry tier actions and no delete action at all.
function lifecyclePolicy(operational = []) {
  const prefixes = [...new Set(operational.filter(Boolean).map((n) => String(n).replace(/\/+$/, '') + '/'))].sort();
  const rules = [];
  if (prefixes.length) {
    rules.push({ enabled: true, name: 'fleet-backup-retention', type: 'Lifecycle',
      definition: { filters: { blobTypes: ['blockBlob'], prefixMatch: prefixes },
        actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: RETENTION_DAYS } } } } });
  }
  for (const [name, prefix] of [['fleet-records-tiering', RECORDS + '/data/'], ['fleet-ledgers-tiering', LEDGERS + '/']]) {
    rules.push({ enabled: true, name, type: 'Lifecycle',
      definition: { filters: { blobTypes: ['blockBlob'], prefixMatch: [prefix] },
        actions: { baseBlob: {
          tierToCool: { daysAfterModificationGreaterThan: COOL_DAYS },
          tierToArchive: { daysAfterModificationGreaterThan: ARCHIVE_DAYS },
        } } } });
  }
  return { rules };
}

// Enrolling an agent into the delete rule. Idempotent, and it REFUSES to enrol a reserved
// container: the day a rule with a delete action names ledgers/ or records/ is the day the
// store stops being a store.
function withOperational(policy, name) {
  const clean = String(name || '').replace(/\/+$/, '');
  if (!clean) throw new Error('backup: cannot enrol an unnamed container');
  if (RESERVED.includes(clean)) throw new Error(`backup: ${clean}/ is a permanent class and is never enrolled into deletion`);
  const have = (((policy || {}).rules || []).find((r) => r.name === 'fleet-backup-retention') || {})
    .definition?.filters?.prefixMatch || [];
  return lifecyclePolicy([...have, clean]);
}

function accountName(subId) {
  return 'fleetbk' + crypto.createHash('sha256').update(String(subId)).digest('hex').slice(0, 12);
}
function subId() {
  const r = runCapture('az', ['account', 'show', '--query', 'id', '-o', 'tsv']);
  return r.ok ? (r.stdout || '').trim() : '';
}
function accountExists(acct) {
  const r = runCapture('az', ['storage', 'account', 'show', '-n', acct, '-g', BACKUP_RG, '--query', 'name', '-o', 'tsv']);
  return r.ok && (r.stdout || '').trim() === acct;
}
// Resolve the store if it exists; '' when absent (callers no-op with a note).
function resolveAccount() {
  const id = subId();
  if (!id) return '';
  const acct = accountName(id);
  return accountExists(acct) ? acct : '';
}

// Containers that exist right now, minus the permanent classes -- the operational set the
// delete rule is allowed to name. Read live so `backup init` is self-correcting on a store
// that already has agents in it.
function listContainers(acct) {
  const r = runCapture('az', ['storage', 'container', 'list', '--account-name', acct,
    '--auth-mode', 'login', '--query', '[].name', '-o', 'tsv']);
  if (!r.ok) return null;
  return (r.stdout || '').trim().split('\n').map((x) => x.trim()).filter(Boolean);
}

function putLifecycle(acct, pol) {
  const tmp = path.join(os.tmpdir(), 'fleet-backup-policy-' + process.pid + '.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify(pol));
    return runCapture('az', ['storage', 'account', 'management-policy', 'create',
      '--account-name', acct, '-g', BACKUP_RG, '--policy', '@' + tmp, '-o', 'none']);
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

function readLifecycle(acct) {
  const r = runCapture('az', ['storage', 'account', 'management-policy', 'show',
    '--account-name', acct, '-g', BACKUP_RG, '--query', 'policy', '-o', 'json']);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout || 'null'); } catch { return null; }
}

// The class's own rules, written beside the data. An archive that cannot explain its retention
// is evidence nobody can rely on. Never overwritten: on a re-run an existing README is left
// alone (a container under time-based retention refuses the overwrite anyway).
function ensureReadme(acct, container, body) {
  const ls = runCapture('az', ['storage', 'blob', 'exists', '--account-name', acct, '-c', container,
    '-n', 'README.md', '--auth-mode', 'login', '--query', 'exists', '-o', 'tsv']);
  if (ls.ok && String(ls.stdout || '').trim().toLowerCase() === 'true') return { ok: true, skipped: true };
  const tmp = path.join(os.tmpdir(), 'fleet-readme-' + container + '-' + process.pid + '.md');
  try {
    fs.writeFileSync(tmp, body);
    return runCapture('az', ['storage', 'blob', 'upload', '--account-name', acct, '-c', container,
      '-n', 'README.md', '-f', tmp, '--auth-mode', 'login', '--overwrite', 'false', '-o', 'none']);
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

const README_RECORDS = [
  '# records — the notebook class',
  '',
  'Curated content an operator reads and acts on: summaries, action items, commitments.',
  '',
  '- NEVER deleted. No lifecycle rule in this account carries a delete action for this prefix.',
  '- records/data/  ages Hot -> Cool at ' + COOL_DAYS + 'd -> Archive at ' + ARCHIVE_DAYS + 'd.',
  '- records/index/ is never tiered. It stays instantly readable forever so a look-back can',
  '  find what it needs and rehydrate only the objects it names.',
  '',
  'Archive retrieval is not instant: standard can take hours, high priority is typically under',
  'an hour for objects this size. Anything inside ' + ARCHIVE_DAYS + ' days reads directly.',
  '',
  'Retention and traceability statement: keel-rca-chat-30.md, appendix.',
  '',
].join('\n');

const README_LEDGERS = [
  '# ledgers — the receipts class',
  '',
  'Hash-chained audit records. They carry metadata, counts and hashes -- never the content of',
  'a prompt, a reply or a note. A chain proves a thing existed unaltered on a date; it does not',
  'say what the thing said.',
  '',
  '- NEVER deleted, and never purged. Chains outlive the agents that wrote them.',
  '- Ages Hot -> Cool at ' + COOL_DAYS + 'd -> Archive at ' + ARCHIVE_DAYS + 'd.',
  '- The container also carries an UNLOCKED time-based immutability policy (' + IMMUTABLE_DAYS + ' days),',
  '  so a mis-scoped lifecycle rule cannot delete a chain. Locking it is irreversible and is a',
  '  separate attested decision, not a build step.',
  '',
  'Retention and traceability statement: keel-rca-chat-30.md, appendix.',
  '',
].join('\n');

function runBackupInit(policy) {
  console.log(c.cyan('backup init'));
  const id = subId();
  if (!id) { console.log(c.red('  ABORT — az not logged in (az account show failed)')); return 2; }
  const acct = accountName(id);
  const region = (policy && policy.defaultRegion) || 'eastus2';
  console.log(c.dim(`  store: ${acct}  (${BACKUP_RG}, ${region}, retention ${RETENTION_DAYS}d)`));
  let r = runCapture('az', ['group', 'create', '-n', BACKUP_RG, '-l', region, '-o', 'none']);
  if (!r.ok) { console.log(c.red('  FAILED creating ' + BACKUP_RG + ': ' + (r.stderr || '').split('\n')[0])); return 1; }
  console.log(c.green('  rg: ' + BACKUP_RG));
  if (!accountExists(acct)) {
    r = runCapture('az', ['storage', 'account', 'create', '-n', acct, '-g', BACKUP_RG, '-l', region,
      '--sku', 'Standard_LRS', '--kind', 'StorageV2', '--min-tls-version', 'TLS1_2',
      '--https-only', 'true', '--allow-blob-public-access', 'false', '-o', 'none']);
    if (!r.ok) { console.log(c.red('  FAILED creating account: ' + (r.stderr || '').split('\n')[0])); return 1; }
  }
  console.log(c.green('  account: ' + acct));
  // The two permanent classes. Shared by every agent, created before the rules that govern them.
  for (const cn of RESERVED) {
    r = runCapture('az', ['storage', 'container', 'create', '--account-name', acct, '-n', cn, '--auth-mode', 'login', '-o', 'none']);
    console.log(r.ok ? c.green('  container: ' + cn + '/') : c.yellow('  container ' + cn + ' failed (non-fatal): ' + (r.stderr || '').split('\n')[0]));
  }
  // READMEs first: ledgers takes an immutability policy below, after which a blob cannot be
  // overwritten -- so the class's own statement is written before the lock goes on.
  for (const [cn, body] of [[RECORDS, README_RECORDS], [LEDGERS, README_LEDGERS]]) {
    const rr = ensureReadme(acct, cn, body);
    console.log(rr.ok ? c.dim('  ' + cn + '/README.md ' + (rr.skipped ? '(already present)' : 'written')) : c.yellow('  ' + cn + '/README.md failed (non-fatal)'));
  }
  // Lifecycle: ONE document, three classes. The delete rule names the operational containers
  // that exist right now and can reach nothing else; the two permanent classes carry tier
  // actions and no delete action at all.
  const operational = (listContainers(acct) || []).filter((n) => !RESERVED.includes(n));
  const pol = lifecyclePolicy(operational);
  r = putLifecycle(acct, pol);
  const delRule = pol.rules.find((x) => x.name === 'fleet-backup-retention');
  console.log(r.ok
    ? c.green(`  lifecycle: delete ${RETENTION_DAYS}d on ${delRule ? delRule.definition.filters.prefixMatch.join(', ') : 'nothing yet (no agent containers)'}`)
    : c.yellow('  lifecycle failed (non-fatal): ' + (r.stderr || '').split('\n')[0]));
  if (r.ok) console.log(c.green(`  lifecycle: ${RECORDS}/data/ and ${LEDGERS}/ -> Cool ${COOL_DAYS}d, Archive ${ARCHIVE_DAYS}d, NO delete action  (${RECORDS}/index/ never tiers)`));
  // Structural backstop on the receipts: an unlocked time-based retention policy means even a
  // mis-scoped rule cannot delete a chain. Unlocked, because locking it cannot be undone.
  r = runCapture('az', ['storage', 'container', 'immutability-policy', 'create', '-g', BACKUP_RG,
    '--account-name', acct, '-c', LEDGERS, '--period', String(IMMUTABLE_DAYS), '-o', 'none']);
  const already = !r.ok && /exist|already/i.test(r.stderr || '');
  console.log((r.ok || already) ? c.green(`  ${LEDGERS}/: immutability ${IMMUTABLE_DAYS}d (unlocked)`) : c.yellow('  immutability policy failed (non-fatal): ' + (r.stderr || '').split('\n')[0]));
  // Deployer gets data-plane rights so list/restore work from the workstation.
  const who = runCapture('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']);
  if (who.ok && (who.stdout || '').trim()) {
    const scope = `/subscriptions/${id}/resourceGroups/${BACKUP_RG}/providers/Microsoft.Storage/storageAccounts/${acct}`;
    r = runCapture('az', ['role', 'assignment', 'create', '--assignee-object-id', (who.stdout || '').trim(),
      '--assignee-principal-type', 'User', '--role', 'Storage Blob Data Contributor', '--scope', scope, '-o', 'none']);
    const dup = !r.ok && /exists/i.test(r.stderr || '');
    console.log((r.ok || dup) ? c.green('  deployer data-plane role: ok') : c.yellow('  deployer role failed (non-fatal): ' + (r.stderr || '').split('\n')[0]));
  }
  console.log(c.green('\nbackup init OK — new provisions wire themselves in; per-agent containers land at up.'));
  return 0;
}

// Called from `up --go` after the deploy: container + container-scoped MSI role.
// Best-effort with a loud skip -- backup must never fail a build.
function ensureAgentBackup(name) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.dim('  backup: store absent — run `fleetctl backup init` (skipped, non-fatal)')); return; }
  let r = runCapture('az', ['storage', 'container', 'create', '--account-name', acct, '-n', name, '--auth-mode', 'login', '-o', 'none']);
  if (!r.ok) { console.log(c.yellow('  backup: container create failed (non-fatal): ' + (r.stderr || '').split('\n')[0])); return; }
  const pid = runCapture('az', ['identity', 'show', '-g', 'rg-' + name, '-n', name + '-identity', '--query', 'principalId', '-o', 'tsv']);
  const id = subId();
  if (pid.ok && (pid.stdout || '').trim() && id) {
    const scope = `/subscriptions/${id}/resourceGroups/${BACKUP_RG}/providers/Microsoft.Storage/storageAccounts/${acct}/blobServices/default/containers/${name}`;
    r = runCapture('az', ['role', 'assignment', 'create', '--assignee-object-id', (pid.stdout || '').trim(),
      '--assignee-principal-type', 'ServicePrincipal', '--role', 'Storage Blob Data Contributor', '--scope', scope, '-o', 'none']);
    const dup = !r.ok && /exists/i.test(r.stderr || '');
    console.log((r.ok || dup) ? c.green(`  backup: container ${name} + MSI role ok (nightly timer pushes here)`) : c.yellow('  backup: MSI role failed (non-fatal): ' + (r.stderr || '').split('\n')[0]));
  } else {
    console.log(c.yellow('  backup: could not resolve agent identity (non-fatal)'));
  }
  // Enrol this container into the delete rule. Not a per-agent policy -- the same standard
  // class list, one prefix longer. If this ever fails the agent's spare parts simply stop
  // being deleted (cost, never loss), and the permanent classes are unreachable from here.
  const cur = readLifecycle(acct);
  let next; try { next = withOperational(cur, name); } catch (e) { console.log(c.yellow('  backup: ' + e.message)); return; }
  const rl = putLifecycle(acct, next);
  const del = next.rules.find((x) => x.name === 'fleet-backup-retention');
  console.log(rl.ok
    ? c.green(`  backup: retention enrols ${name}/ (${RETENTION_DAYS}d; ${del.definition.filters.prefixMatch.length} operational container(s))`)
    : c.yellow('  backup: retention enrolment failed (non-fatal, nothing is deleted): ' + (rl.stderr || '').split('\n')[0]));
}

function listBlobs(name, acct) {
  const r = runCapture('az', ['storage', 'blob', 'list', '--account-name', acct, '-c', name,
    '--auth-mode', 'login', '--query', '[].{n:name,t:properties.lastModified}', '-o', 'tsv']);
  if (!r.ok) return null;
  return (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]).sort();
}

function runBackupList(name) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('backup list: store absent — run `fleetctl backup init`')); return 2; }
  const blobs = listBlobs(name, acct);
  if (blobs === null) { console.log(c.red('backup list: cannot read container (does it exist? was the agent provisioned after backup init?)')); return 1; }
  if (!blobs.length) { console.log(c.yellow(`no backups for ${name} yet (timer pushes daily; \`fleetctl backup snapshot ${name}\` forces one)`)); return 0; }
  for (const b of blobs) console.log('  ' + b);
  console.log(c.dim(`\n${blobs.length} blob(s); latest: ${blobs[blobs.length - 1]}`));
  return 0;
}

// ---------------------------------------------------------------------------
// Reading the store. Pure parts first so the decisions are testable without az:
// what a row IS, and what can be DONE with it. An Archive blob cannot be read until
// it is rehydrated, and the failure mode we refuse to ship is a download that dies
// with a raw Azure error instead of saying "this is in the back room, here is how
// long it takes to fetch it".

const SAFE_BLOB = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
function safeBlobName(n) { return SAFE_BLOB.test(String(n || '')); }

// az ... -o tsv gives name<TAB>tier<TAB>archiveStatus<TAB>lastModified<TAB>size, with the
// literal 'None' for nulls. A blob written and never tiered reports no tier at all -- that is
// Hot, not unknown.
function blobRows(tsv) {
  return String(tsv || '').trim().split('\n').filter(Boolean).map((line) => {
    const [name, tier, archiveStatus, modified, size] = line.split('\t').map((x) => (x || '').trim());
    const none = (v) => (!v || v === 'None' ? null : v);
    return { name, tier: none(tier) || 'Hot', archiveStatus: none(archiveStatus), modified: none(modified), size: Number(size) || 0 };
  }).filter((r) => r.name);
}

// What a fetch of this blob would do right now.
function fetchPlan(row) {
  const r = row || {};
  if (r.archiveStatus) return { act: 'pending', why: 'rehydration already in progress (' + r.archiveStatus + ') — it lands in the tier it was asked for; try again later' };
  if (String(r.tier).toLowerCase() === 'archive') {
    return { act: 'rehydrate', why: 'this blob is in Archive (older than ' + ARCHIVE_DAYS + ' days) and cannot be read until it is rehydrated' };
  }
  return { act: 'download', why: null };
}

// Honest ETAs, not promises: Azure publishes standard rehydration as up to 15 hours and high
// priority as typically under an hour for objects below 10 GiB. Ledger and record objects are
// far smaller than that, which is why High is the default here.
function rehydrateEta(priority) {
  return String(priority).toLowerCase() === 'standard'
    ? 'standard priority: up to about 15 hours'
    : 'high priority: usually under an hour for objects this size';
}

// ---------------------------------------------------------------------------
// Intake: the workstation on-ramp. An operator drops files into the agent's OWN container under
// intake/, and the agent's timer sweeps them into staging within five minutes. Nothing is
// processed by that sweep -- Process stays the operator's decision, exactly as it is for a panel
// upload. The panel is the on-ramp from any machine; this is the one for a batch at the desk.
//
// Names are stamped, not trusted: two screenshots called Screenshot.png dropped a minute apart
// are two items, not one overwriting the other.
function intakeBlobName(file, stamp) {
  const base = path.basename(String(file)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return 'intake/' + (stamp || new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')) + '-' + base;
}

function runIntakePut(agent, files) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('intake put: store absent — run `fleetctl backup init`')); return 2; }
  if (!files.length) { console.log(c.red('intake put: no files given')); return 2; }
  let bad = 0, sent = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) { console.log(c.red('  missing: ' + f)); bad++; continue; }
    const name = intakeBlobName(f);
    const r = runCapture('az', ['storage', 'blob', 'upload', '--account-name', acct, '-c', agent, '-n', name,
      '-f', f, '--auth-mode', 'login', '--overwrite', 'false', '-o', 'none']);
    if (!r.ok) { console.log(c.red('  FAILED ' + path.basename(f) + ': ' + (r.stderr || '').split('\n')[0])); bad++; continue; }
    console.log(c.green('  dropped ') + c.dim(name));
    sent++;
  }
  console.log(sent
    ? c.dim(`\n${sent} item(s) waiting for ${agent} — its sweep stages them within 5 minutes, then Process moves them into the pipeline`)
    : c.yellow('\nnothing dropped'));
  return bad ? 1 : 0;
}

function runIntakeList(agent) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('intake list: store absent — run `fleetctl backup init`')); return 2; }
  const r = runCapture('az', ['storage', 'blob', 'list', '--account-name', acct, '-c', agent, '--auth-mode', 'login',
    '--prefix', 'intake/', '--query', '[].[name,properties.blobTier,properties.archiveStatus,properties.lastModified,properties.contentLength]', '-o', 'tsv']);
  if (!r.ok) { console.log(c.red('intake list: cannot read ' + agent + '/ — ' + (r.stderr || '').split('\n')[0])); return 1; }
  const rows = blobRows(r.stdout);
  if (!rows.length) { console.log(c.green(`nothing waiting for ${agent} — an empty drop box means the sweep took everything`)); return 0; }
  for (const b of rows) console.log('  ' + (b.modified || '').slice(0, 19).padEnd(20) + String(Math.round(b.size / 1024) + 'K').padStart(8) + '  ' + b.name);
  console.log(c.dim(`\n${rows.length} item(s) not yet swept (the timer runs every 5 minutes; the VM must be running)`));
  return 0;
}

function runBackupLs(container, opts = {}) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('backup ls: store absent — run `fleetctl backup init`')); return 2; }
  const args = ['storage', 'blob', 'list', '--account-name', acct, '-c', container, '--auth-mode', 'login',
    '--query', '[].[name,properties.blobTier,properties.archiveStatus,properties.lastModified,properties.contentLength]', '-o', 'tsv'];
  if (opts.prefix) { args.push('--prefix', opts.prefix); }
  const r = runCapture('az', args);
  if (!r.ok) { console.log(c.red('backup ls: cannot read ' + container + '/ — ' + (r.stderr || '').split('\n')[0])); return 1; }
  const rows = blobRows(r.stdout).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!rows.length) { console.log(c.yellow('nothing in ' + container + '/' + (opts.prefix ? opts.prefix : '') + ' yet')); return 0; }
  for (const b of rows) {
    const p = fetchPlan(b);
    const tag = p.act === 'download' ? c.green(b.tier) : p.act === 'pending' ? c.cyan('rehydrating') : c.yellow('Archive');
    console.log('  ' + tag.padEnd(20) + ' ' + (b.modified || '').slice(0, 19).padEnd(20) + ' ' + String(Math.round(b.size / 1024) + 'K').padStart(8) + '  ' + b.name);
  }
  console.log(c.dim(`\n${rows.length} blob(s) in ${container}/${opts.prefix || ''}`));
  const cold = rows.filter((b) => fetchPlan(b).act === 'rehydrate').length;
  if (cold) console.log(c.dim(`  ${cold} in Archive — fetch one with: fleetctl backup rehydrate ${container} <blob>`));
  return 0;
}

function runBackupGet(container, blob, opts = {}) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('backup get: store absent — run `fleetctl backup init`')); return 2; }
  if (!safeBlobName(blob)) { console.log(c.red('backup get: blob name fails the safe charset')); return 2; }
  const one = runCapture('az', ['storage', 'blob', 'list', '--account-name', acct, '-c', container, '--auth-mode', 'login',
    '--prefix', blob, '--query', '[].[name,properties.blobTier,properties.archiveStatus,properties.lastModified,properties.contentLength]', '-o', 'tsv']);
  if (!one.ok) { console.log(c.red('backup get: cannot read ' + container + '/ — ' + (one.stderr || '').split('\n')[0])); return 1; }
  const row = blobRows(one.stdout).find((b) => b.name === blob);
  if (!row) { console.log(c.red(`backup get: ${container}/${blob} not found`)); return 1; }
  const plan = fetchPlan(row);
  if (plan.act !== 'download') {
    console.log(c.yellow('backup get REFUSED — ' + plan.why));
    if (plan.act === 'rehydrate') console.log(c.dim(`  fleetctl backup rehydrate ${container} ${blob}   (${rehydrateEta('high')})`));
    return 2;
  }
  const out = opts.out || path.join(process.cwd(), path.basename(blob));
  const r = runCapture('az', ['storage', 'blob', 'download', '--account-name', acct, '-c', container, '-n', blob,
    '-f', out, '--auth-mode', 'login', '--overwrite', 'true', '-o', 'none']);
  if (!r.ok) { console.log(c.red('backup get FAILED: ' + (r.stderr || '').split('\n')[0])); return 1; }
  console.log(c.green('  downloaded ' + container + '/' + blob) + c.dim('  -> ' + out));
  return 0;
}

function runBackupPut(container, file, opts = {}) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('backup put: store absent — run `fleetctl backup init`')); return 2; }
  if (!fs.existsSync(file)) { console.log(c.red('backup put: file not found: ' + file)); return 2; }
  const name = opts.as || path.basename(file);
  if (!safeBlobName(name)) { console.log(c.red('backup put: blob name fails the safe charset')); return 2; }
  const r = runCapture('az', ['storage', 'blob', 'upload', '--account-name', acct, '-c', container, '-n', name,
    '-f', file, '--auth-mode', 'login', '--overwrite', 'false', '-o', 'none']);
  if (!r.ok) {
    const dup = /already exists|BlobAlreadyExists/i.test(r.stderr || '');
    console.log(dup
      ? c.yellow(`backup put: ${container}/${name} already exists — append-only by design, nothing overwritten`)
      : c.red('backup put FAILED: ' + (r.stderr || '').split('\n')[0]));
    return dup ? 0 : 1;
  }
  console.log(c.green('  put ' + container + '/' + name));
  return 0;
}

function runRehydrate(container, blob, opts = {}) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('backup rehydrate: store absent — run `fleetctl backup init`')); return 2; }
  if (!safeBlobName(blob)) { console.log(c.red('backup rehydrate: blob name fails the safe charset')); return 2; }
  const priority = String(opts.priority || 'High');
  if (!/^(high|standard)$/i.test(priority)) { console.log(c.red('backup rehydrate: --priority must be High or Standard')); return 2; }
  const tier = String(opts.tier || 'Hot');
  if (!/^(hot|cool)$/i.test(tier)) { console.log(c.red('backup rehydrate: --tier must be Hot or Cool')); return 2; }
  const r = runCapture('az', ['storage', 'blob', 'set-tier', '--account-name', acct, '-c', container, '-n', blob,
    '--tier', tier, '--rehydrate-priority', priority, '--auth-mode', 'login', '-o', 'none']);
  if (!r.ok) { console.log(c.red('backup rehydrate FAILED: ' + (r.stderr || '').split('\n')[0])); return 1; }
  console.log(c.green('  rehydration started: ' + container + '/' + blob + ' -> ' + tier));
  console.log(c.dim('  ' + rehydrateEta(priority) + '. The blob stays unreadable until it lands; re-check with:'));
  console.log(c.dim(`    fleetctl backup ls ${container} --prefix ${blob}`));
  return 0;
}

// Trigger an on-VM push via the guest agent (no SSH). mode: 'final' | 'push'.
function triggerPush(name, mode) {
  return runCapture('az', ['vm', 'run-command', 'invoke', '-g', 'rg-' + name, '-n', name + '-vm',
    '--command-id', 'RunShellScript', '--scripts', '/usr/local/bin/agent-backup ' + (mode === 'final' ? 'final' : 'push')]);
}

function runBackupSnapshot(name) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('backup snapshot: store absent — run `fleetctl backup init`')); return 2; }
  console.log(c.cyan(`backup snapshot ${name}  (via az vm run-command — VM must be running)`));
  const r = triggerPush(name, 'push');
  if (r.ok && /pushed:/.test(r.stdout || '')) { console.log(c.green('  snapshot pushed')); return 0; }
  console.log(c.red('  snapshot failed: ' + ((r.stderr || r.stdout || 'no output').split('\n').filter(Boolean)[0] || '').slice(0, 160)));
  return 1;
}

// Decommission surface 0: bank a last snapshot before teardown. Best-effort,
// loud, never blocks -- a deallocated/broken VM prints the newest existing blob.
function finalSnapshot(name) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.dim('  0 final snapshot     skipped (no backup store — run `fleetctl backup init` to enable)')); return; }
  const r = triggerPush(name, 'final');
  if (r.ok && /pushed:/.test(r.stdout || '')) { console.log(c.green('  0 final snapshot     pushed to ' + acct + '/' + name)); return; }
  const blobs = listBlobs(name, acct) || [];
  const latest = blobs.length ? blobs[blobs.length - 1] : 'none';
  console.log(c.yellow('  0 final snapshot     FAILED (VM off/unreachable?) — newest existing backup: ' + latest));
}

function runRestore(name, opts = {}) {
  const acct = resolveAccount();
  if (!acct) { console.log(c.red('restore: store absent — run `fleetctl backup init`')); return 2; }
  let blob = opts.blob;
  if (!blob) {
    const blobs = listBlobs(name, acct);
    if (!blobs || !blobs.length) { console.log(c.red(`restore: no backups for ${name}`)); return 1; }
    blob = blobs[blobs.length - 1];
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(blob)) { console.log(c.red('restore: blob name fails safe charset')); return 2; }
  console.log(c.cyan(`restore ${name}  <-  ${blob}`));
  console.log(c.dim('  (via az vm run-command; VM must be running; containers restart after extract)'));
  const r = runCapture('az', ['vm', 'run-command', 'invoke', '-g', 'rg-' + name, '-n', name + '-vm',
    '--command-id', 'RunShellScript', '--scripts', '/usr/local/bin/agent-backup restore ' + blob]);
  const out = (r.stdout || '');
  if (r.ok && /restored:/.test(out)) { console.log(c.green('restore OK — ' + blob)); return 0; }
  console.log(c.red('restore failed: ' + ((r.stderr || out || 'no output').split('\n').filter(Boolean)[0] || '').slice(0, 200)));
  console.log(c.dim('  note: /usr/local/bin/agent-backup exists on fleet-provisioned builds; legacy hand-built VMs gain it at rebuild.'));
  return 1;
}

module.exports = { accountName, resolveAccount, runBackupInit, ensureAgentBackup, runBackupList, runBackupSnapshot, finalSnapshot, runRestore, listBlobs, triggerPush, BACKUP_RG, lifecyclePolicy, withOperational, LEDGERS, RECORDS, RESERVED, RETENTION_DAYS, COOL_DAYS, ARCHIVE_DAYS, blobRows, fetchPlan, rehydrateEta, safeBlobName, runBackupLs, runBackupGet, runBackupPut, runRehydrate, intakeBlobName, runIntakePut, runIntakeList };
