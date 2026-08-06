'use strict';
const { c, runCapture } = require('./util');

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

// Seed an agent's Key Vault with the two bootstrap secrets. The API keys come from the
// environment (never CLI args, so they don't land in shell history / process listings as
// fleetctl args). Re-running overwrites the keys (rotation). App-TOTP was removed with the
// edge-only auth migration (Cloudflare Access is the gate); no TOTP is seeded or shown.
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

  const v = resolveVault(agent);
  if (!v.ok) { console.log(c.red('\nset-secrets ABORT — ' + v.reason)); return 2; }
  console.log(c.dim(`  vault: ${v.vault}  (resource group ${v.rg})`));

  const writes = [
    ['anthropic-api-key', anth],
    ['openrouter-api-key', ork],
  ];
  for (const [name, value] of writes) {
    const r = setSecret(v.vault, name, value);
    if (!r.ok) { console.log(c.red(`\nset-secrets FAILED writing '${name}': ${r.reason}`)); return 1; }
    console.log(c.green(`  set ${name}`));
  }

  console.log(c.green('\nset-secrets OK — vault seeded. The agent fetches these at first boot (no prompt).'));
  console.log(c.dim(`  Verify: az keyvault secret list --vault-name ${v.vault} --query "[].name" -o tsv`));
  return 0;
}

module.exports = { resolveVault, setSecret, runSetSecrets };
