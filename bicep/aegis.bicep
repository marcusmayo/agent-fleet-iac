// aegis.bicep — subscription-scoped entrypoint for the CONTROL PLANE.
//
// Separate from main.bicep on purpose. main.bicep provisions an agent: it is driven by
// the agent contract, its resource group joins the fleet inventory, and `fleetctl
// decommission` can tear down everything it made. None of that should be true of the
// thing that issues those commands, so the control plane gets its own entrypoint, its
// own tag set, and no path into the agent lane.
targetScope = 'subscription'

@description('Control-plane name. Becomes the RG + VM name.')
@minLength(2)
@maxLength(24)
param aegisName string = 'aegis'

@description('Azure region.')
param location string = 'eastus2'

@description('VM size.')
param vmSize string = 'Standard_B2s_v2'

@description('Admin username on the VM.')
param adminUsername string = 'aegisadmin'

@description('SSH public key for the admin user.')
param sshPublicKey string

@description('CIDR allowed to reach SSH for first-login bootstrap. Empty = tunnel-only (hardened default).')
param sshAccessCidr string = ''

@description('Cloudflare Tunnel token for the control plane.')
@secure()
param cloudflareTunnelToken string

@description('Aegis control-plane repo.')
param aegisRepoUrl string = 'https://github.com/marcusmayo/aegis.git'

@description('Fleet IaC repo — fleetctl is spawned from this checkout.')
param fleetRepoUrl string = 'https://github.com/marcusmayo/agent-fleet-iac.git'

@description('Git ref for both repos. Empty = default-branch HEAD.')
param repoRef string = ''

@description('Existing fleet Key Vault holding Cloudflare credentials.')
param fleetVaultName string = 'kv-keelpm-aegis'

var rgName = 'rg-${aegisName}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: {
    app: 'agent-fleet'
    // role, not agent: the tag is what makes the distinction legible in the portal and
    // in any sweep that enumerates the fleet.
    role: 'control-plane'
    aegis: aegisName
  }
}

module aegisVm 'modules/aegis-vm.bicep' = {
  scope: rg
  name: '${aegisName}-vm-deploy'
  params: {
    aegisName: aegisName
    location: location
    vmSize: vmSize
    adminUsername: adminUsername
    sshPublicKey: sshPublicKey
    sshAccessCidr: sshAccessCidr
    cloudflareTunnelToken: cloudflareTunnelToken
    aegisRepoUrl: aegisRepoUrl
    fleetRepoUrl: fleetRepoUrl
    repoRef: repoRef
    fleetVaultName: fleetVaultName
  }
}

output resourceGroup string = rg.name
output aegis string = aegisName
output vmName string = aegisVm.outputs.vmName
output privateIp string = aegisVm.outputs.privateIp
output identityPrincipalId string = aegisVm.outputs.identityPrincipalId
output identityClientId string = aegisVm.outputs.identityClientId
output publicIpEnabled bool = !empty(sshAccessCidr)
output buildRef string = empty(repoRef) ? 'default-branch-HEAD' : repoRef
output grantsPending string = aegisVm.outputs.grantsPending
