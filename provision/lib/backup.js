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
  // Lifecycle: delete backup blobs after RETENTION_DAYS (management policy, idempotent PUT).
  const pol = { rules: [{ enabled: true, name: 'fleet-backup-retention', type: 'Lifecycle',
    definition: { filters: { blobTypes: ['blockBlob'] },
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: RETENTION_DAYS } } } } }] };
  const tmp = path.join(os.tmpdir(), 'fleet-backup-policy-' + process.pid + '.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify(pol));
    r = runCapture('az', ['storage', 'account', 'management-policy', 'create',
      '--account-name', acct, '-g', BACKUP_RG, '--policy', '@' + tmp, '-o', 'none']);
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  console.log(r.ok ? c.green(`  retention: ${RETENTION_DAYS}d lifecycle`) : c.yellow('  retention policy failed (non-fatal): ' + (r.stderr || '').split('\n')[0]));
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

module.exports = { accountName, resolveAccount, runBackupInit, ensureAgentBackup, runBackupList, runBackupSnapshot, finalSnapshot, runRestore, BACKUP_RG };
