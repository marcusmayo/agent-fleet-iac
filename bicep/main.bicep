// main.bicep — subscription-scoped entrypoint for ONE agent.
// One agent = one resource group (bulkhead) + one VM. The `agentProfile`
// parameter selects Argus (multi-interface) vs Keel (portfolio) behaviour;
// both are the SAME converged image, differentiated only by config.
// Decommission = delete the resource group (see scripts/decommission.sh).
targetScope = 'subscription'

@description('Short agent name, e.g. heimdall, cerberus, helm. Becomes the RG + VM name.')
@minLength(2)
@maxLength(24)
param agentName string

@description('Agent profile. Same image, different config profile.')
@allowed([
  'argus'
  'keel'
])
param agentProfile string

@description('Azure region.')
param location string = 'eastus2'

@description('VM size. Default B2s_v2: 2 vCPU / 8 GiB burstable — fits the spiky claude -p + Node workload.')
param vmSize string = 'Standard_B2s_v2'

@description('Admin username on the VM.')
param adminUsername string = 'agentadmin'

@description('SSH public key for the admin user. Public material, not a secret.')
param sshPublicKey string

@description('CIDR allowed to reach SSH for first-login bootstrap (e.g. 203.0.113.5/32). Empty = NO public IP, tunnel-only (hardened).')
param sshAccessCidr string = ''

@description('Cloudflare Tunnel token for this agent (Zero Trust dashboard). Injected into cloud-init, scrubbed after install.')
@secure()
param cloudflareTunnelToken string

@description('Git URL cloned by cloud-init to build the agent image (public repo).')
param repoUrl string = 'https://github.com/marcusmayo/keel-portfolio-management.git'

@description('Git ref (branch, tag, or commit SHA) to check out for a reproducible, pinned build. Empty = default-branch HEAD. Pin this to the commit that carries your ADO lane.')
param repoRef string = ''

var rgName = 'rg-${agentName}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: {
    app: 'agent-fleet'
    agent: agentName
    profile: agentProfile
  }
}

module agentVm 'modules/vm.bicep' = {
  scope: rg
  name: '${agentName}-vm-deploy'
  params: {
    agentName: agentName
    agentProfile: agentProfile
    location: location
    vmSize: vmSize
    adminUsername: adminUsername
    sshPublicKey: sshPublicKey
    sshAccessCidr: sshAccessCidr
    cloudflareTunnelToken: cloudflareTunnelToken
    repoUrl: repoUrl
    repoRef: repoRef
  }
}

output resourceGroup string = rg.name
output agent string = agentName
output profile string = agentProfile
output publicIpEnabled bool = !empty(sshAccessCidr)
output privateIp string = agentVm.outputs.privateIp
output buildRef string = empty(repoRef) ? 'default-branch-HEAD' : repoRef
