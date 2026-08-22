// aegis-vm.bicep — the CONTROL PLANE host. Deliberately NOT modules/vm.bicep.
//
// This is not an agent and must never be mistaken for one. It carries no agent image,
// no docker stack, no per-agent Key Vault and no backup storage. It runs one thing:
// aegis.js, bound to loopback, reached only through a Cloudflare tunnel that dials it
// locally. Keeping it on its own module is what stops the agent lane -- caps, registry,
// decommission -- from ever applying to the thing that operates them.
//
// PRIVILEGE IS NOT GRANTED HERE. The identity created below starts with nothing. Its
// Key Vault read (on the pre-existing fleet vault, in another resource group) and its
// subscription-scope Contributor are granted post-apply as separate attested steps, so
// every grant to the most privileged identity in the fleet is an explicit, ledgered act
// rather than a line buried in infrastructure that no one re-reads.

@description('Control-plane name. Becomes the RG + VM name. Distinct from any agent name.')
@minLength(2)
@maxLength(24)
param aegisName string = 'aegis'

@description('Azure region.')
// northcentralus, not eastus2: the B-series is NotAvailableForSubscription in
// eastus2/eastus/westus2 for this subscription, and the control plane runs 24/7 so the
// difference is structural rather than marginal (~$7/mo here vs ~$31 for the cheapest
// eastus2 alternative). Nothing about a control plane needs regional proximity to the
// agents: it reaches them through Cloudflare tunnels over the public internet and reaches
// Azure through a global endpoint, so the split costs nothing operationally.
param location string = 'northcentralus'

@description('VM size. The control plane spawns fleetctl and serves one operator; it does not build images.')
// B2ats_v2 (2 vCPU / 1 GiB). B2s_v2 was the earlier note but is NotAvailableForSubscription;
// this is the cheapest size actually offered. 1 GiB is tight for the az CLI (Python, bursty),
// so cloud-init adds swap. Escape hatch if it thrashes: Standard_B2als_v2 (4 GiB, same
// family and region) is a size change and nothing else.
param vmSize string = 'Standard_B2ats_v2'

@description('Admin username on the VM.')
param adminUsername string = 'aegisadmin'

@description('SSH public key for the admin user. Public material, not a secret.')
param sshPublicKey string

@description('CIDR allowed to reach SSH for first-login bootstrap. Empty = NO public IP, tunnel-only (hardened default).')
param sshAccessCidr string = ''

@description('Cloudflare Tunnel token for the control plane. Injected into cloud-init, scrubbed after install.')
@secure()
param cloudflareTunnelToken string

@description('Git URL for the Aegis control-plane repo.')
param aegisRepoUrl string = 'https://github.com/marcusmayo/aegis.git'

@description('Git URL for the fleet IaC repo — the control plane spawns fleetctl from this checkout.')
param fleetRepoUrl string = 'https://github.com/marcusmayo/fleet.git'

@description('Git ref for both repos. Empty = default-branch HEAD.')
param repoRef string = ''

@description('Existing fleet Key Vault holding the Cloudflare credentials. Read access is granted POST-APPLY, not here.')
param fleetVaultName string = 'kv-keelpm-aegis'

var vmName = '${aegisName}-vm'
var uaiName = '${aegisName}-identity'
var wantPublicIp = !empty(sshAccessCidr)

var ciRaw = loadTextContent('../cloud-init/aegis-cloudflared.yaml')
var ciFinal = replace(replace(replace(replace(replace(replace(replace(replace(
  ciRaw,
  '__CF_TUNNEL_TOKEN__', cloudflareTunnelToken),
  '__ADMIN_USER__', adminUsername),
  '__AEGIS_REPO_URL__', aegisRepoUrl),
  '__FLEET_REPO_URL__', fleetRepoUrl),
  '__REPO_REF__', repoRef),
  '__KEY_VAULT_NAME__', fleetVaultName),
  '__MSI_CLIENT_ID__', uai.properties.clientId),
  '__MSI_PRINCIPAL_ID__', uai.properties.principalId)

// Deny-all inbound, exactly as the agents. The tunnel is outbound-initiated, so the
// control plane needs no inbound rule to be reachable -- and an operator who can reach
// it over the network without Cloudflare Access would bypass the only authentication
// this service has.
var denyAllRule = [
  {
    name: 'deny-all-inbound'
    properties: {
      priority: 4096
      direction: 'Inbound'
      access: 'Deny'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '*'
    }
  }
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${aegisName}-nsg'
  location: location
  properties: {
    securityRules: denyAllRule
  }
}

// Separate address space from the agent VNets (10.30.0.0/24) so the control plane can
// never be peered into an agent's network by accident.
resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${aegisName}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.40.0.0/24'
      ]
    }
    subnets: [
      {
        name: 'aegis-subnet'
        properties: {
          addressPrefix: '10.40.0.0/24'
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

resource pip 'Microsoft.Network/publicIPAddresses@2023-11-01' = if (wantPublicIp) {
  name: '${aegisName}-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: '${aegisName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipcfg'
        properties: {
          subnet: {
            id: vnet.properties.subnets[0].id
          }
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: wantPublicIp ? { id: pip.id } : null
        }
      }
    ]
  }
}

// The identity exists; it holds nothing yet. See the header: grants are post-apply.
resource uai 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: uaiName
  location: location
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uai.id}': {}
    }
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: base64(ciFinal)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output vmName string = vmName
output identityPrincipalId string = uai.properties.principalId
output identityClientId string = uai.properties.clientId
output fleetVaultName string = fleetVaultName
output grantsPending string = 'Key Vault Secrets User on ${fleetVaultName} + subscription Contributor are NOT granted by this template — run the attested grant step.'
