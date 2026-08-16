'use strict';
const { c, runCapture } = require('./util');
const path = require('path');
const { loadContract } = require('./contract');

// The single Key Vault in the agent's resource group (rg-<agent>).
function resolveVault(agent) {
  const rg = `rg-${agent}`;
  const r = runCapture('az', ['keyvault', 'list', '-g', rg, '--query', '[0].name', '-o', 'tsv']);
  if (r.notFound) return { ok: false, reason: 'az CLI not found on PATH' };
  if (!r.ok) return { ok: false, reason: (r.stderr || 'az returned non-zero').split('\n')[0] };
  const name = (r.stdout || '').trim();
  if (!name) return { ok: false, reason: `no Key Vault in ${rg} — is the agent deployed with the vault bicep (step 1)?` };
  return { ok: true, vault: name, rg };
}

function setSecret(vault, name, value) {
  const r = runCapture('az', ['keyvault', 'secret', 'set', '--vault-name', vault, '--name', name, '--value', value, '-o', 'none']);
  return r.ok ? { ok: true } : { ok: false, reason: (r.stderr || 'az returned non-zero').split('\n')[0] };
}

// Seed an agent's Key Vault with the bootstrap secrets its profile's first boot
// fetches — mechanism in core, names per profile (PROFILE_SECRETS). The API keys come from the
// environment (never CLI args, so they don't land in shell history / process listings as
// fleetctl args). Re-running overwrites the keys (rotation). App-TOTP was removed with the
// edge-only auth migration (Cloudflare Access is the gate); no TOTP is seeded or shown.
// Vault secret names each profile's bootstrap fetches at first boot. keel:
// standardized pair (proven example-02/03/04). castor: setup-wizard-era names its
// bootstrap dies on when absent — model-api-key feeds the OpenRouter gateway lane,
// vision-api-key the direct-Anthropic vision path; anthropic-api-key doubles as
// castor's optional web-direct enabler, so it is seeded for both profiles.
const PROFILE_SECRETS = {
  keel: (anth, ork) => [['anthropic-api-key', anth], ['openrouter-api-key', ork]],
  castor: (anth, ork) => [['model-api-key', ork], ['vision-api-key', anth], ['anthropic-api-key', anth]],
};

// A Forbidden from the vault's data plane is one of two things: the deployer's Secrets Officer
// grant was skipped (empty DEPLOYER_OBJECT_ID at deploy) or has not propagated yet. Say which
// fix to try, with the exact commands, instead of a bare error.
// Post-deploy vault roles, read back and repaired. The template's assignments are named by a
// deterministic guid whose inputs do not change on a re-provision, so ARM can report success
// while the NEW identity holds nothing (see modules/vm.bicep). Here the principal is READ from
// Azure and the assignment created if absent -- immune to guid collisions, idempotent ("exists"
// is success), and never fatal: the deploy already happened, this repairs its last mile.
//   agent identity -> Key Vault Secrets User    (the agent reads its runtime secrets at boot)
//   deployer       -> Key Vault Secrets Officer (so `set-secrets` can write them)
function ensureVaultRoles(name, deployerId) {
  const rg = 'rg-' + name;
  const kv = runCapture('az', ['keyvault', 'list', '-g', rg, '--query', '[0].id', '-o', 'tsv']);
  const kvId = kv.ok ? (kv.stdout || '').trim() : '';
  if (!kvId) { console.log(c.yellow('  vault roles: no Key Vault in ' + rg + ' (skipped, non-fatal)')); return; }
  const grant = (objectId, principalType, role, label) => {
    if (!objectId) { console.log(c.yellow('  vault roles: no ' + label + ' object id (skipped)')); return; }
    const have = runCapture('az', ['role', 'assignment', 'list', '--assignee', objectId, '--scope', kvId, '--query', "[?roleDefinitionName=='" + role + "'] | length(@)", '-o', 'tsv']);
    if (have.ok && (have.stdout || '').trim() === '1') { console.log(c.green('  vault roles: ' + label + ' already holds ' + role)); return; }
    const r = runCapture('az', ['role', 'assignment', 'create', '--assignee-object-id', objectId,
      '--assignee-principal-type', principalType, '--role', role, '--scope', kvId, '-o', 'none']);
    const dup = !r.ok && /exists/i.test(r.stderr || '');
    console.log((r.ok || dup) ? c.green('  vault roles: ' + label + ' granted ' + role) : c.yellow('  vault roles: ' + label + ' ' + role + ' FAILED (non-fatal): ' + (r.stderr || '').split('\n')[0]));
  };
  const pid = runCapture('az', ['identity', 'show', '-g', rg, '-n', name + '-identity', '--query', 'principalId', '-o', 'tsv']);
  grant(pid.ok ? (pid.stdout || '').trim() : '', 'ServicePrincipal', 'Key Vault Secrets User', 'agent identity');
  grant((deployerId || '').trim(), 'User', 'Key Vault Secrets Officer', 'deployer');
}

function forbiddenHint(vault, rg) {
  return c.yellow('  Forbidden on the vault data plane: either the deploy did not grant you Key Vault Secrets Officer (empty DEPLOYER_OBJECT_ID) or the grant is still propagating (up to ~10 min).') + '\n' +
    c.dim('  check:  az role assignment list --assignee <your object id> --scope <vault id> -o table   (vault id: az keyvault show -n ' + vault + ' -g ' + rg + ' --query id -o tsv)') + '\n' +
    c.dim('  grant:  az role assignment create --assignee-object-id <your object id> --assignee-principal-type User --role "Key Vault Secrets Officer" --scope <vault id>') + '\n' +
    c.dim('  then wait a minute and re-run set-secrets ' + '(nothing partial was written past the failing name).');
}
function runSetSecrets(agent) {
  console.log(c.cyan(`set-secrets  ${agent}`));

  const anth = process.env.ANTHROPIC_API_KEY || '';
  const ork = process.env.OPENROUTER_API_KEY || '';
  const problems = [];
  if (!anth) problems.push('ANTHROPIC_API_KEY not set in the environment');
  if (!ork) problems.push('OPENROUTER_API_KEY not set in the environment');
  else if (!/^sk-or-/.test(ork)) problems.push('OPENROUTER_API_KEY must start with sk-or- (placeholder or wrong key)');
  if (problems.length) {
    console.log(c.red('\nset-secrets ABORT — nothing written:'));
    for (const p of problems) console.log('  - ' + p);
    console.log(c.dim('\n  Set them in the environment first, then re-run:'));
    console.log(c.dim('    $env:ANTHROPIC_API_KEY = "sk-ant-..."'));
    console.log(c.dim('    $env:OPENROUTER_API_KEY = "sk-or-..."'));
    return 2;
  }

  const cFile = path.join(path.resolve(__dirname, '..', '..'), 'agents', `${agent}.agent.jsonc`);
  const lc = loadContract(cFile);
  if (!lc.ok) {
    console.log(c.red('\nset-secrets ABORT — cannot read the contract to determine the profile:'));
    for (const e of lc.errors) console.log('  - ' + e);
    return 2;
  }
  const mkWrites = PROFILE_SECRETS[lc.value.profile];
  if (!mkWrites) { console.log(c.red(`\nset-secrets ABORT — no secret map for profile '${lc.value.profile}'`)); return 2; }
  const writes = mkWrites(anth, ork);
  console.log(c.dim(`  profile: ${lc.value.profile} — seeding ${writes.map(w => w[0]).join(', ')}`));

  const v = resolveVault(agent);
  if (!v.ok) { console.log(c.red('\nset-secrets ABORT — ' + v.reason)); return 2; }
  console.log(c.dim(`  vault: ${v.vault}  (resource group ${v.rg})`));

  for (const [name, value] of writes) {
    const r = setSecret(v.vault, name, value);
    if (!r.ok) {
      console.log(c.red(`\nset-secrets FAILED writing '${name}': ${r.reason}`));
      if (/Forbidden|not authorized|AuthorizationFailed/i.test(String(r.reason || ''))) console.log(forbiddenHint(v.vault, v.rg));
      return 1;
    }
    console.log(c.green(`  set ${name}`));
  }

  console.log(c.green('\nset-secrets OK — vault seeded. The agent fetches these at first boot (no prompt).'));
  console.log(c.dim(`  Verify: az keyvault secret list --vault-name ${v.vault} --query "[].name" -o tsv`));
  return 0;
}

module.exports = { resolveVault, setSecret, ensureVaultRoles, runSetSecrets };
