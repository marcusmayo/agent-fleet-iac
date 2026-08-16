'use strict';
// Pure function: validated contract -> the exact resource names provisioning will
// create. Names mirror bicep/modules/vm.bicep and scripts/cloudflare-provision.ps1
// so `plan` previews reality, not a guess. Purely derived — safe to run anywhere.

function derive(v) {
  const fqdn = `${v.name}.${v.domain}`;
  const wantsVault = v.profile === 'castor';

  return {
    azure: {
      resourceGroup: `rg-${v.name}`,
      region: v.region,
      vmName: `${v.name}-vm`,
      // The size that will actually deploy: the bicepparam reads $VM_SIZE, else the main.bicep
      // default -- read the same way here so plan, capacity preflight and deployment agree.
      vmSize: (process.env.VM_SIZE || '').trim() || 'Standard_D2s_v3',
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
      aegisServiceToken: `aegis-${v.name}  (Service Auth token + policy — created at 'up')`,
    },
    register: {
      name: v.name,
      profile: v.profile,
      host: fqdn,
      clientId: `<aegis-${v.name} Service Auth Client ID — at up>`,
      clientSecret: `<aegis-${v.name} Service Auth Client Secret — at up>`,
    },
  };
}

module.exports = { derive };
