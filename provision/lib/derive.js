'use strict';
// Pure function: validated contract -> the exact resource names provisioning will
// create. Names mirror bicep/modules/vm.bicep and scripts/cloudflare-provision.ps1
// so `plan` previews reality, not a guess. Purely derived — safe to run anywhere.

function derive(v) {
  const fqdn = `${v.name}.${v.domain}`;
  // Every agent gets a per-agent Key Vault and a user-assigned identity -- vm.bicep has said
  // `var wantsVault = true` since the vault became the first-boot secret path. This read still
  // said castor-only, so `plan` hid the vault and the identity for a keel agent and then
  // deployed both: a plan that under-reports what it is about to create is worse than no plan.
  const wantsVault = true;

  return {
    azure: {
      resourceGroup: `rg-${v.name}`,
      region: v.region,
      vmName: `${v.name}-vm`,
      // The size that will actually deploy: the bicepparam reads $VM_SIZE, else the main.bicep
      // default -- read the same way here so plan, capacity preflight and deployment agree.
      vmSize: (v.vmSize || '').trim() || (process.env.VM_SIZE || '').trim() || 'Standard_D2s_v3',
      profile: v.profile,
      publicIpEnabled: v.sshCidr !== '',
      sshCidr: v.sshCidr,
      repoUrl: v.repoUrl,
      repoRef: v.repoRef || 'default-branch HEAD',
      wantsVault,
      paramFile: `bicep/params/${v.profile}.bicepparam`,
    },
    cloudflare: {
      fqdn,
      tunnel: v.name,
      dnsCname: `${fqdn}  ->  <tunnel-id>.cfargotunnel.com  (proxied)`,
      accessApp: `${v.name}  (self-hosted, One-time PIN)`,
      accessAppHost: fqdn,
      accessPolicy: `${v.name}-operator`,
      ingress: `${fqdn}  ->  http://localhost:${v.webchatPort}`,
      aegisServiceToken: `<plane>-${v.name}  (Service Auth token + policy — created at 'up', named for the provisioning plane)`,
    },
    register: {
      name: v.name,
      profile: v.profile,
      host: fqdn,
      clientId: `<<plane>-${v.name} Service Auth Client ID — at up>`,
      clientSecret: `<<plane>-${v.name} Service Auth Client Secret — at up>`,
    },
  };
}

module.exports = { derive };
