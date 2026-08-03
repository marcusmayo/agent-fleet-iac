'use strict';
const { c, findFleetRoot, runCapture, which } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const pf = require('./preflight');

const kv = (label, val) => console.log(`  ${String(label).padEnd(16)}${val}`);

function preview(v) {
  const d = derive(v);

  console.log(c.bold('\nAzure  ') + c.dim('(subscription-scoped; decommission = delete the RG)'));
  kv('resource group', d.azure.resourceGroup);
  kv('region', d.azure.region);
  kv('vm', `${d.azure.vmName}  (${d.azure.vmSize}, Ubuntu 24.04)`);
  kv('network', `${v.name}-vnet / ${v.name}-nsg (deny-all-inbound) / ${v.name}-nic`);
  kv('public IP', d.azure.publicIpEnabled ? `${v.name}-pip  (temp-SSH target; ${d.azure.sshCidr})` : 'none — hardened, tunnel-only');
  kv('profile', d.azure.profile);
  if (d.azure.wantsVault) {
    kv('key vault', `${v.name}-kv-<suffix>  (RBAC; operator secrets set post-apply)`);
    kv('identity', `${v.name}-identity  (user-assigned MSI: KV Secrets User + Storage Blob Contributor)`);
    kv('backup', `${v.name}sa<suffix>  (identity-based blob backup)`);
  }
  kv('repo', `${d.azure.repoUrl} @ ${d.azure.repoRef}`);
  kv('param file', d.azure.paramFile);

  console.log(c.bold('\nCloudflare front door'));
  kv('fqdn', d.cloudflare.fqdn);
  kv('tunnel', d.cloudflare.tunnel);
  kv('dns', d.cloudflare.dnsCname);
  kv('access app', `${d.cloudflare.accessApp} on ${d.cloudflare.accessAppHost}`);
  kv('access policy', d.cloudflare.accessPolicy);
  kv('ingress', d.cloudflare.ingress);
  kv('aegis token', d.cloudflare.aegisServiceToken);

  console.log(c.bold('\nRegister  ') + c.dim('(entry appended to aegis.config.json at the register phase)'));
  kv('name', d.register.name);
  kv('profile', d.register.profile);
  kv('host', d.register.host);
  kv('clientId', d.register.clientId);
  kv('clientSecret', d.register.clientSecret);
}

function whatIfEnv(v, pubkey) {
  const env = { ...process.env };
  env.AGENT_NAME = v.name;
  env.AZ_LOCATION = v.region;
  env.SSH_CIDR = v.sshCidr || '';
  env.REPO_URL = v.repoUrl;
  env.REPO_REF = v.repoRef || '';
  env.SSH_PUBKEY = pubkey || '';
  // what-if does not validate the token — a placeholder is fine for the diff.
  env.CF_TUNNEL_TOKEN = env.CF_TUNNEL_TOKEN || 'whatif-placeholder-not-a-real-token';
  if (v.profile === 'castor' && !env.DEPLOYER_OBJECT_ID) env.DEPLOYER_OBJECT_ID = '';
  return env;
}

function runPlan(file, opts = {}) {
  console.log(c.cyan(`plan  ${file}`));
  const res = loadContract(file);
  if (!res.ok) {
    console.log(c.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  const v = res.value;
  console.log(c.green('\nContract valid — previewing (nothing will be created).'));
  preview(v);

  const root = findFleetRoot();
  const paramRel = `bicep/params/${v.profile}.bicepparam`;
  const whatIfArgs = ['deployment', 'sub', 'what-if', '--name', `whatif-${v.name}`, '--location', v.region, '--parameters', paramRel];

  console.log(c.bold('\nAzure what-if  ') + c.dim('(read-only; exact command shown)'));
  console.log('  cd ' + (root || '<fleet-root>'));
  console.log('  ' + c.dim(`AGENT_NAME=${v.name} AZ_LOCATION=${v.region} SSH_PUBKEY=<key> CF_TUNNEL_TOKEN=<placeholder> \\`));
  console.log('  az ' + whatIfArgs.join(' '));

  const skip = (why) => {
    console.log(c.yellow(`\nSKIPPED what-if: ${why}`));
    console.log(c.dim('Preview above is complete. Run `plan` on your workstation for the live diff.'));
    return opts.requireWhatif ? 2 : 0;
  };

  if (!root) return skip('fleet root not found (set $FLEET_DIR)');
  if (!which('az')) return skip('az CLI not found on PATH');
  if (!runCapture('az', ['account', 'show']).ok) return skip('az present but not logged in (`az login`)');
  const pubkey = pf.sshPubkey().pubkey;
  if (!pubkey) return skip('no SSH public key resolved (VM resource needs one to validate); set $SSH_PUBKEY or $AF_SSH_PUBKEY_FILE');

  console.log(c.bold('\nRunning what-if…\n'));
  const r = runCapture('az', whatIfArgs, { cwd: root, env: whatIfEnv(v, pubkey) });
  if (r.stdout) console.log(r.stdout);
  if (!r.ok) {
    if (r.stderr) console.log(c.red(r.stderr));
    console.log(c.red('\nwhat-if command failed (see error above).'));
    return 1;
  }
  console.log(c.green('\nplan OK — what-if completed (nothing applied).'));
  return 0;
}

module.exports = { runPlan };
