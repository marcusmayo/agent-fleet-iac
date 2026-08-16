'use strict';
// aegis-up.js — provision the CONTROL PLANE. Separate lane from up.js on purpose.
//
// WHICH POLICY GATES APPLY, and why:
//   budget          YES. It creates a billable resource, and the point of a spend cap is
//                   that it bounds spend regardless of what is spending it.
//   maxFleet        NO.  That cap bounds AGENTS. The control plane is not one, and
//                   counting it would make the agent ceiling mean something different
//                   from what it says.
//   allowedRegions  NO, by deliberate exemption. The control plane lives in
//                   northcentralus because the B-series is NotAvailableForSubscription in
//                   the agents' region; forcing agreement would either block this or
//                   widen the agents' allowed regions for no reason. The exemption is
//                   stated here and printed in the plan so it is never a silent gap.
//
// The Cloudflare front door (tunnel + token, DNS, Access app) is created FIRST by
// scripts/cloudflare-provision.ps1, exactly as for an agent -- the tunnel token is a
// required input to the template, so it cannot be otherwise. This lane does not wrap
// that script: seeing the two steps is worth more than hiding one.
const fs = require('fs');
const path = require('path');
const { c: col, which, findFleetRoot, runCapture } = require('./util');
const { loadAegisContract } = require('./aegis-contract');
const pf = require('./preflight');
const { checkCapacity } = require('./capacity');

// findFleetRoot locates the repo by its agent-lane markers; assert the control-plane
// template is present too, so a partial checkout fails here rather than at az.
function fleetRoot() {
  const r = findFleetRoot();
  if (r && fs.existsSync(path.join(r, 'bicep', 'aegis.bicep'))) return r;
  return '';
}

// Budget is the one policy gate that applies here, and it is STRICTER than on the agent
// lane by deliberate design.
//
// checkBudget() returns ok:true with warn:true when spend cannot be read, because the
// agent lane still has maxFleet as a structural bound underneath it -- an unreadable
// budget there degrades to a warning, not an opening. This lane is exempt from maxFleet
// (the control plane is not an agent), so there is nothing underneath: an unreadable
// budget would mean no bound at all. So a warn is treated as a REFUSAL here. The one
// place a spend cap is the only cap is the one place it must not degrade to advisory.
function budgetGate(root) {
  try {
    const { loadPolicy } = require('./policy');
    const pol = loadPolicy(path.join(root, 'provision', 'aegis.policy.jsonc'));
    const { readBudgetSpend, checkBudget } = require('./budget');
    const spend = readBudgetSpend(pol.budgetName);
    const r = checkBudget(pol.maxMonthlyBudgetUsd, spend);
    const readable = !!(spend && spend.ok);
    return {
      ok: !!r.ok && !r.warn,
      detail: r.warn
        ? (r.message || 'budget unreadable') + ' — REFUSED here: this lane has no maxFleet backstop'
        : (r.message || ''),
      cap: pol.maxMonthlyBudgetUsd,
      spent: readable ? spend.amount : null,
      unit: readable ? (spend.unit || 'USD') : '',
    };
  } catch (e) {
    return { ok: false, detail: 'policy/budget unreadable: ' + e.message, cap: null, spent: null, unit: '' };
  }
}

function printPlan(v, R) {
  console.log(col.bold('\nCONTROL PLANE plan — ' + v.name));
  console.log('  contract        ' + v.name + '  (control plane; NOT an agent)');
  console.log('  region / size   ' + v.region + '  ' + v.vmSize);
  console.log('  resource group  ' + v.resourceGroup + '   vm ' + v.vmName);
  console.log('  hostname        https://' + v.hostname + '  ->  tunnel  ->  127.0.0.1:' + v.port);
  console.log('  ssh             ' + (v.sshAccessCidr ? v.sshAccessCidr : 'none (hardened: no public IP, tunnel-only)'));
  console.log('  vault (read)    ' + v.fleetVaultName + '   ' + col.dim('(grant is a separate attested step)'));
  console.log(col.bold('\n  policy gates'));
  console.log('    budget         ' + (R.budget.ok ? col.green('PASS') : col.red('FAIL')) +
    (R.budget.cap != null ? col.dim('   cap $' + R.budget.cap) : '') +
    (R.budget.spent != null ? col.dim(', month-to-date ' + R.budget.unit + ' ' + R.budget.spent.toFixed(2)) : ''));
  if (R.budget.detail) console.log(col.dim('                   ' + R.budget.detail));
  console.log('    maxFleet       ' + col.dim('n/a — bounds agents; the control plane is not one'));
  console.log('    allowedRegions ' + col.dim('exempt — see aegis-up.js header (B-series unavailable in the agents\' region)'));
  // Not a policy gate: an Azure Can't, read here so the refusal happens in plan and
  // names the quota to request, rather than at ARM with a tracking id (see capacity.js).
  console.log('    capacity       ' + (R.capacity.ok ? col.green('PASS') : col.red('FAIL')) + col.dim('   ' + R.capacity.detail));
  if (!R.capacity.ok && R.capacity.request) console.log(col.dim('                   request: ') + R.capacity.request);
  console.log(col.bold('\n  steps when you run --go'));
  console.log('    1. ' + col.dim('you run:') + ' scripts/cloudflare-provision.ps1 -ControlPlane  ' + col.dim('(tunnel + token, DNS, Access app)'));
  console.log('    2. az deployment sub create -> ' + v.resourceGroup + ' + ' + v.vmName + col.red('   — BILLABLE'));
  console.log('    3. ' + col.dim('then:') + ' attested grants (Key Vault read, subscription Contributor)');
  console.log(col.bold('\n  NOT granted by the deployment'));
  console.log('    ' + col.dim('The identity is created empty. Until the grant step runs, the service starts but'));
  console.log('    ' + col.dim('cannot read Cloudflare credentials and fleetctl cannot provision anything.'));
  console.log(col.bold('\n  inputs'));
  console.log('    tunnel token   ' + (R.tunnelToken
    ? col.green('present') + col.dim('  ($CF_TUNNEL_TOKEN)')
    : col.red('MISSING') + col.dim('  — run scripts/cloudflare-provision.ps1 -ControlPlane -AgentName ' + v.name + ' first')));
  console.log('    ssh public key ' + (R.pubkey
    ? col.green('resolved') + col.dim('  (' + R.pubkeyFrom + ')')
    : col.red('MISSING') + col.dim('  — ' + R.pubkeyFrom)));
}

async function runAegisUp(file, opts = {}) {
  console.log(col.cyan(`aegis up${opts.go ? ' --go' : ' (plan)'}  ${file}`));
  const res = loadAegisContract(file);
  if (!res.ok) {
    console.log(col.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  const v = res.value;
  const root = fleetRoot();
  // SSH key: the SAME resolver as the agent lane -- $SSH_PUBKEY, else ~/.ssh/keel_t2.pub
  // (override with $AF_SSH_PUBKEY_FILE) -- so the operator sets nothing new for this lane.
  // A raw env value that is a <placeholder> is kept as-is so the preflight below refuses it
  // loudly, rather than quietly falling through to the file.
  const rawPub = (process.env.SSH_PUBKEY || '').trim();
  const sk = pf.sshPubkey();
  const R = {
    root,
    az: which('az'),
    budget: root ? budgetGate(root) : { ok: false, detail: 'fleet root not found', cap: null, spent: null, unit: '' },
    capacity: checkCapacity(v.region, v.vmSize),
    tunnelToken: (process.env.CF_TUNNEL_TOKEN || '').trim(),
    pubkey: (rawPub && /[<>]/.test(rawPub)) ? rawPub : (sk.pubkey || ''),
    pubkeyFrom: sk.result.detail,
  };
  printPlan(v, R);

  if (!opts.go) {
    console.log(col.yellow('\nplan only — nothing was created. Re-run with --go to execute.'));
    return 0;
  }

  // --- attestation: same grammar as provisioning, distinct sentence -----------------
  const required = 'I approve provisioning the control plane ' + v.name;
  if ((opts.attest || '').trim() !== required) {
    console.log(col.red('\naegis up --go REFUSED — attestation must read exactly:'));
    console.log('  ' + required);
    return 3;
  }

  // --- fail-fast preflight: nothing is created if any of this is missing ------------
  // Placeholders BEFORE missing, matching up.js: "your token is still <paste>" is a far
  // more actionable message than "az is missing", and a value that looks set but isn't
  // is the failure most likely to waste a deployment.
  const placeholders = [];
  for (const [k, val] of [['CF_TUNNEL_TOKEN', R.tunnelToken], ['SSH_PUBKEY', R.pubkey]]) {
    if (val && /[<>]/.test(val)) placeholders.push(k);
  }
  if (placeholders.length) {
    console.log(col.red('\naegis up --go ABORT (nothing created) — these still hold <placeholder> text: $' + placeholders.join(', $')));
    console.log('  Set them to the real values (no angle brackets), then re-run.');
    return 2;
  }
  const missing = [];
  if (!R.root) missing.push('fleet root (bicep/aegis.bicep)');
  if (!R.az) missing.push('az');
  if (!R.tunnelToken) missing.push('$CF_TUNNEL_TOKEN (run scripts/cloudflare-provision.ps1 first)');
  if (!R.pubkey) missing.push('$SSH_PUBKEY');
  if (missing.length) {
    console.log(col.red('\naegis up --go ABORT (nothing created) — missing: ' + missing.join(', ')));
    return 2;
  }
  if (!R.budget.ok) {
    console.log(col.red('\naegis up --go ABORT (nothing created) — budget gate: ' + (R.budget.detail || 'over cap')));
    return 2;
  }
  if (!R.capacity.ok) {
    console.log(col.red('\naegis up --go ABORT (nothing created) — capacity: ' + R.capacity.detail));
    if (R.capacity.request) console.log('  request it: ' + R.capacity.request);
    return 2;
  }

  const args = [
    'deployment', 'sub', 'create',
    '--name', 'aegis-' + v.name + '-' + Date.now().toString(36),
    '--location', v.region,
    '--template-file', path.join(R.root, 'bicep', 'aegis.bicep'),
    '--parameters',
    'aegisName=' + v.name,
    'location=' + v.region,
    'vmSize=' + v.vmSize,
    'adminUsername=' + v.adminUsername,
    'sshPublicKey=' + R.pubkey,
    'sshAccessCidr=' + v.sshAccessCidr,
    'cloudflareTunnelToken=' + R.tunnelToken,
    'aegisRepoUrl=' + v.aegisRepoUrl,
    'fleetRepoUrl=' + v.fleetRepoUrl,
    'repoRef=' + v.repoRef,
    'fleetVaultName=' + v.fleetVaultName,
    '--output', 'json',
  ];
  console.log(col.cyan('\ndeploying — this takes several minutes...'));
  // runCapture, not a bare spawnSync: on Windows `az` is a .cmd shim that Node >= 20.12
  // refuses to spawn without a shell (EINVAL -> "deployment FAILED: no output"). runCapture
  // shells out only for that shim and passes ONE pre-quoted command string, quoting the
  // one arg here that carries spaces (the SSH public key). It is the same helper the budget
  // gate and cfcred already run live on the workstation.
  const r = runCapture('az', args, { maxBuffer: 32 * 1024 * 1024 });
  if (!r.ok) {
    console.log(col.red('\ndeployment FAILED:'));
    console.log(((r.stderr || r.stdout || (r.error && r.error.message) || 'no output').split('\n').filter(Boolean).slice(0, 6).join('\n')));
    return 1;
  }
  let out = {};
  try { out = JSON.parse(r.stdout || '{}').properties.outputs || {}; } catch (e) { /* printed below anyway */ }
  const val = (k) => (out[k] && out[k].value !== undefined ? out[k].value : '(unknown)');
  console.log(col.green('\ncontrol plane deployed'));
  console.log('  resource group     ' + val('resourceGroup'));
  console.log('  vm                 ' + val('vmName'));
  console.log('  identity principal ' + val('identityPrincipalId'));
  console.log('  identity client id ' + val('identityClientId'));
  console.log(col.yellow('\nNEXT — the identity holds nothing yet. Until these are granted, the service'));
  console.log(col.yellow('starts but cannot read Cloudflare credentials, and fleetctl cannot provision:'));
  console.log('  ' + col.dim('Key Vault read:') + ' az role assignment create --assignee ' + val('identityPrincipalId') +
    ' --role "Key Vault Secrets User" --scope <resource-id of ' + v.fleetVaultName + '>');
  console.log('  ' + col.dim('Subscription:  ') + ' az role assignment create --assignee ' + val('identityPrincipalId') +
    ' --role Contributor --scope /subscriptions/<sub-id>');
  console.log(col.dim('\nThen on the VM: systemctl restart aegis'));
  return 0;
}

module.exports = { runAegisUp, loadAegisContract };
