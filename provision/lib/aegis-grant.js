'use strict';
// aegis-grant.js — the control plane's privilege, granted as attested acts.
//
// aegis-vm.bicep creates the identity EMPTY on purpose: the most privileged identity in
// the fleet should acquire its rights through explicit, ledgered decisions rather than a
// line buried in a template no one re-reads. This lane is those decisions.
//
// Four verbs, and structurally nothing else:
//   vault        Key Vault Secrets User on the fleet vault  (reads cf-api-token / cf-account-id)
//   contributor  Contributor at subscription scope         (fleetctl provisions/decommissions agents)
//   backups      Storage Blob Data Contributor on the fleet backup ACCOUNT (fleetctl migrate:
//                the plane reads a source snapshot and hands it into the target's container;
//                agents keep reading only their own). Explicit and ledgered rather than
//                exercised silently through Contributor's listKeys.
//   locks        a CUSTOM role holding exactly Microsoft.Authorization/locks/* at subscription
//                scope, so the hosted plane can mirror protectedAgents onto CanNotDelete locks
//                (Contributor cannot touch locks; that action lives with Owner/UAA, which this
//                lane refuses). The definition is created on first use if absent -- that step
//                needs the operator's Owner rights, which is why it is an attested act here.
// Owner and User Access Administrator are not verbs here, so this path cannot give the
// identity the power to escalate itself. Contributor cannot assign roles.
//
// Each act is: attested (verbatim sentence, one per verb), idempotent (an existing
// assignment is a ledgered no-op, not a second grant), and ledgered -- approved, no-op,
// refused, or failed -- in provision/policy-audit.jsonl, next to the policy it belongs
// with, in the same record shape as policy.set. Plan mode reads and prints; it grants
// nothing. Nothing is typed by hand: the principal id is read from Azure by name.
const { c: col, runCapture, which } = require('./util');
const { loadAegisContract } = require('./aegis-contract');
const { resolvePolicyPath, ledger } = require('./policy');

const VERBS = Object.freeze({
  vault: { role: 'Key Vault Secrets User', label: 'Key Vault read (fleet vault)' },
  contributor: { role: 'Contributor', label: 'Contributor (subscription)' },
  backups: { role: 'Storage Blob Data Contributor', label: 'fleet backup store read/write (migrate)' },
  locks: { role: 'Fleet Lock Operator', label: 'resource locks (protectedAgents mirror)', custom: { actions: ['Microsoft.Authorization/locks/*'], description: 'Aegis control plane: create/delete CanNotDelete locks on agent resource groups (protectedAgents mirror). Nothing else.' } },
});

function attestSentence(name, what, v) {
  if (what === 'vault') return 'I approve granting the control plane ' + name + ' read on ' + v.fleetVaultName;
  if (what === 'backups') return 'I approve granting the control plane ' + name + ' read and write on the fleet backup store';
  if (what === 'locks') return 'I approve granting the control plane ' + name + ' lock management on the subscription';
  return 'I approve granting the control plane ' + name + ' Contributor on the subscription';
}

const az = (args) => runCapture('az', args);
const tsv = (r) => (r.ok ? (r.stdout || '').trim() : '');
const firstLine = (s) => String(s || '').split('\n').filter(Boolean)[0] || '';

// Everything the plan needs, read from Azure by NAME (never typed): principal id of the
// identity the template created, the target scope, and whether the grant already exists.
function gather(v, what) {
  const R = { az: which('az'), what, role: VERBS[what].role, label: VERBS[what].label };
  R.principalId = tsv(az(['identity', 'show', '-g', v.resourceGroup, '-n', v.name + '-identity', '--query', 'principalId', '-o', 'tsv']));
  R.subscriptionId = tsv(az(['account', 'show', '--query', 'id', '-o', 'tsv']));
  R.vaultRbac = null;
  if (what === 'vault') {
    R.scope = tsv(az(['keyvault', 'show', '-n', v.fleetVaultName, '--query', 'id', '-o', 'tsv']));
    // RBAC vault -> role assignment. Access-policy vault -> set-policy. Read it, don't guess.
    R.vaultRbac = tsv(az(['keyvault', 'show', '-n', v.fleetVaultName, '--query', 'properties.enableRbacAuthorization', '-o', 'tsv'])).toLowerCase();
  } else if (what === 'backups') {
    // The fleet backup store: one account in rg-fleet-backups (see backup.js). Absent -> no scope -> refused.
    const bk = require('./backup');
    R.backupAccount = bk.resolveAccount();
    R.scope = (R.backupAccount && R.subscriptionId)
      ? '/subscriptions/' + R.subscriptionId + '/resourceGroups/' + bk.BACKUP_RG + '/providers/Microsoft.Storage/storageAccounts/' + R.backupAccount
      : '';
  } else {
    R.scope = R.subscriptionId ? '/subscriptions/' + R.subscriptionId : '';
  }
  // custom role: does the definition exist yet? (--go creates it if not, then assigns)
  R.customDef = null;
  if (VERBS[what].custom && R.subscriptionId) {
    const r = az(['role', 'definition', 'list', '--name', VERBS[what].role, '--scope', '/subscriptions/' + R.subscriptionId, '-o', 'json']);
    try { const arr = r.ok ? JSON.parse(r.stdout || '[]') : null; R.customDef = Array.isArray(arr) ? (arr.length ? 'present' : 'absent') : null; } catch { R.customDef = null; }
  }
  R.existing = null;   // null = could not read; [] = none; [..] = present
  if (R.principalId && R.scope) {
    if (what === 'vault' && R.vaultRbac === 'false') {
      const r = az(['keyvault', 'show', '-n', v.fleetVaultName, '-o', 'json']);
      try {
        const pols = (JSON.parse(r.stdout || '{}').properties || {}).accessPolicies || [];
        R.existing = r.ok ? pols.filter((p) => p && p.objectId === R.principalId) : null;
      } catch { R.existing = null; }
    } else {
      const r = az(['role', 'assignment', 'list', '--assignee', R.principalId, '--role', R.role, '--scope', R.scope, '-o', 'json']);
      try { R.existing = r.ok ? JSON.parse(r.stdout || '[]') : null; } catch { R.existing = null; }
    }
  }
  return R;
}

function printPlan(v, R, required) {
  console.log(col.bold('\nCONTROL PLANE grant — ' + v.name + ' / ' + R.what));
  console.log('  grant           ' + R.label + '   role "' + R.role + '"');
  console.log('  identity        ' + v.name + '-identity in ' + v.resourceGroup + '  ->  ' + (R.principalId ? col.green(R.principalId) : col.red('NOT FOUND (deploy first)')));
  console.log('  scope           ' + (R.scope ? R.scope : col.red('unresolved')) + (R.what === 'vault' && R.vaultRbac ? col.dim('   (vault RBAC: ' + R.vaultRbac + ')') : ''));
  if (VERBS[R.what].custom) console.log('  custom role     ' + (R.customDef === 'present' ? col.green('defined') : R.customDef === 'absent' ? col.yellow('not defined yet — --go creates it (needs Owner) with actions ' + VERBS[R.what].custom.actions.join(', ')) : col.yellow('unreadable')));
  const ex = R.existing === null ? col.yellow('unreadable') : (R.existing.length ? col.green('already granted — --go would be a ledgered no-op') : 'not yet granted');
  console.log('  current state   ' + ex);
  console.log('  attestation     ' + col.dim(required));
  console.log(col.bold('\n  NOT expressible here') + col.dim('  Owner, User Access Administrator, any other role — this lane has four verbs.'));
}

async function runAegisGrant(file, what, opts = {}) {
  console.log(col.cyan('aegis grant ' + (what || '?') + (opts.go ? ' --go' : ' (plan)') + '  ' + file));
  if (!VERBS[what]) {
    console.log(col.red("\naegis grant: what must be 'vault', 'contributor', 'backups' or 'locks' — this lane can grant nothing else"));
    return 2;
  }
  const res = loadAegisContract(file);
  if (!res.ok) {
    console.log(col.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  const v = res.value;
  const R = gather(v, what);
  const required = attestSentence(v.name, what, v);
  printPlan(v, R, required);

  if (!opts.go) {
    console.log(col.yellow('\nplan only — nothing was granted. Re-run with --go --attest "' + required + '" to execute.'));
    return 0;
  }

  const policyPath = resolvePolicyPath();
  const base = { action: 'aegis.grant', key: what, name: v.name, role: R.role, scope: R.scope || null, principalId: R.principalId || null };
  const led = (extra) => { try { return policyPath ? ledger(policyPath, { ...base, ...extra }) : null; } catch { return null; } };

  if ((opts.attest || '').trim() !== required) {
    led({ phrase: opts.attest || '', outcome: 'refused: attestation mismatch' });
    console.log(col.red('\naegis grant --go REFUSED — attestation must read exactly:'));
    console.log('  ' + required);
    return 3;
  }
  const missing = [];
  if (!R.az) missing.push('az');
  if (!R.principalId) missing.push(v.name + '-identity principal id (is the control plane deployed?)');
  if (!R.scope) missing.push(what === 'vault' ? 'vault resource id (' + v.fleetVaultName + ')' : what === 'backups' ? 'fleet backup store (run fleetctl backup init first)' : 'subscription id');
  if (missing.length) {
    led({ phrase: opts.attest, outcome: 'refused: missing ' + missing.join(', ') });
    console.log(col.red('\naegis grant --go ABORT (nothing granted) — missing: ' + missing.join(', ')));
    return 2;
  }
  if (Array.isArray(R.existing) && R.existing.length) {
    led({ phrase: opts.attest, outcome: 'ok (no-op: already granted)' });
    console.log(col.green('\nalready granted — no-op, ledgered.'));
    return 0;
  }

  // custom role definition first, if this verb needs one and it is absent (idempotent by name)
  if (VERBS[what].custom && R.customDef !== 'present') {
    const def = { Name: R.role, IsCustom: true, Description: VERBS[what].custom.description, Actions: VERBS[what].custom.actions, NotActions: [], DataActions: [], NotDataActions: [], AssignableScopes: ['/subscriptions/' + R.subscriptionId] };
    const tmp = require('path').join(require('os').tmpdir(), 'fleet-role-' + Date.now().toString(36) + '.json');
    require('fs').writeFileSync(tmp, JSON.stringify(def), 'utf8');
    const rd = az(['role', 'definition', 'create', '--role-definition', '@' + tmp, '-o', 'none']);
    try { require('fs').unlinkSync(tmp); } catch { /* best effort */ }
    if (!rd.ok) {
      const why = firstLine(rd.stderr || rd.stdout) || 'az role definition create failed';
      led({ phrase: opts.attest, outcome: 'failed: custom role definition: ' + why });
      console.log(col.red('\ngrant FAILED (ledgered): could not create custom role "' + R.role + '": ' + why + '  — this step needs Owner on the subscription'));
      return 1;
    }
    console.log(col.dim('  custom role "' + R.role + '" defined (actions: ' + VERBS[what].custom.actions.join(', ') + ')'));
  }
  let r;
  if (what === 'vault' && R.vaultRbac === 'false') {
    r = az(['keyvault', 'set-policy', '-n', v.fleetVaultName, '--object-id', R.principalId, '--secret-permissions', 'get', 'list', '-o', 'none']);
  } else {
    // --assignee-object-id + principal type: no Graph lookup, so a freshly created
    // identity that Graph has not indexed yet cannot make this fail for the wrong reason.
    r = az(['role', 'assignment', 'create', '--assignee-object-id', R.principalId, '--assignee-principal-type', 'ServicePrincipal',
      '--role', R.role, '--scope', R.scope, '-o', 'none']);
  }
  if (!r.ok) {
    const why = firstLine(r.stderr || r.stdout || (r.error && r.error.message)) || 'az returned non-zero';
    led({ phrase: opts.attest, outcome: 'failed: ' + why });
    console.log(col.red('\ngrant FAILED (ledgered): ' + why));
    return 1;
  }
  const rec = led({ phrase: opts.attest, outcome: 'ok' });
  console.log(col.green('\ngranted: ' + R.label) + col.dim('  (ledgered ' + (rec ? 'ok' : 'NO — policy-audit path unresolved') + ')'));
  if (what === 'contributor') console.log(col.dim('Then on the VM: systemctl restart aegis  (fetch-secrets + az MSI login run at start)'));
  return 0;
}

module.exports = { runAegisGrant, attestSentence, VERBS };
