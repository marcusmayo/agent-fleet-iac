// vm.bicep — network + compute for one agent.
// Posture: NSG denies ALL inbound. SSH is opt-in and TEMPORARY only -
// scripts/ssh-open.ps1 adds a scoped rule (your /32); ssh-close.ps1 removes it.
// A public IP is created only if sshAccessCidr is set, to give that temp rule a target.
// All app traffic (webchat) rides the Cloudflare Tunnel (outbound-only), so the
// NSG denies ALL inbound by default; an explicit deny sits at 4096 so the posture
// is visible, not implied by platform defaults.

param agentName string
param agentProfile string
param location string
param vmSize string
param adminUsername string
param sshPublicKey string
param sshAccessCidr string
@secure()
param cloudflareTunnelToken string
param repoUrl string
param repoRef string
param deployerObjectId string = ''

var vmName = '${agentName}-vm'
var wantPublicIp = !empty(sshAccessCidr)

// --- Castor-profile vault/identity/backup gate ---
// Keel is unchanged. For Castor, port Castor's Terraform: a per-agent Key Vault,
// a user-assigned managed identity, and identity-based blob backup. Operator
// secrets are set post-apply via `az keyvault secret set` (none are created here);
// bootstrap.sh fetches them at first login via the MI with a retry loop to absorb
// RBAC propagation lag (Bicep has no time_sleep equivalent).
var wantsVault = agentProfile == 'castor'
var suffix = substring(uniqueString(subscription().id, agentName), 0, 5)
var kvName = '${agentName}-kv-${suffix}'
var saName = toLower('${agentName}sa${suffix}')
var uaiName = '${agentName}-identity'
// Built-in role definition GUIDs (stable across clouds).
var roleKvSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var roleKvSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var roleStorageBlobContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// cloud-init: one file, placeholders replaced at deploy time. The tunnel token is
// the only secret in customData and is scrubbed from cloud logs after install;
// runtime secrets (TOTP, model key) are injected later via bootstrap over SSH.
// For Castor, the vault name and MI client id are written into .provision-flags so
// bootstrap.sh can do a non-interactive managed-identity fetch; empty for Keel.
var ciRaw = loadTextContent('../cloud-init/agent-cloudflared.yaml')
var kvNameForCi = wantsVault ? kvName : ''
var msiClientIdForCi = wantsVault ? uai!.properties.clientId : ''
var ciFinal = replace(replace(replace(replace(replace(replace(replace(replace(ciRaw, '__CF_TUNNEL_TOKEN__', cloudflareTunnelToken), '__AGENT_PROFILE__', agentProfile), '__ADMIN_USER__', adminUsername), '__REPO_URL__', repoUrl), '__REPO_REF__', repoRef), '__KEY_VAULT_NAME__', kvNameForCi), '__MSI_CLIENT_ID__', msiClientIdForCi), '__AGENT_NAME__', agentName)

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
  name: '${agentName}-nsg'
  location: location
  properties: {
    securityRules: denyAllRule
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${agentName}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.30.0.0/24'
      ]
    }
    subnets: [
      {
        name: 'agent-subnet'
        properties: {
          addressPrefix: '10.30.0.0/24'
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

resource pip 'Microsoft.Network/publicIPAddresses@2023-11-01' = if (wantPublicIp) {
  name: '${agentName}-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: '${agentName}-nic'
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

// --- Castor-profile: managed identity, per-agent Key Vault, identity-based backup ---
resource uai 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (wantsVault) {
  name: uaiName
  location: location
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = if (wantsVault) {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    // RBAC data plane (no access policies); operator writes secrets post-apply.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    // Purge protection intentionally omitted (off) for a clean teardown — demo
    // posture; set enablePurgeProtection: true for a durable deployment.
  }
}

resource backupStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (wantsVault) {
  name: saName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Backups are written by the VM's managed identity — no account keys on the VM.
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (wantsVault) {
  parent: backupStorage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource backupsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (wantsVault) {
  parent: blobService
  name: 'backups'
  properties: {
    publicAccess: 'None'
  }
}

// identity -> read secrets
resource raKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (wantsVault) {
  name: guid(kv.id, uaiName, roleKvSecretsUser)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsUser)
    principalId: uai!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// identity -> write backups (data plane; no account keys on the VM)
resource raStorageBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (wantsVault) {
  name: guid(backupStorage.id, uaiName, roleStorageBlobContributor)
  scope: backupStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleStorageBlobContributor)
    principalId: uai!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// deployer -> create the operator secrets post-apply (az keyvault secret set)
resource raKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (wantsVault && !empty(deployerObjectId)) {
  name: guid(kv.id, deployerObjectId, roleKvSecretsOfficer)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsOfficer)
    principalId: deployerObjectId
    principalType: 'User'
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: wantsVault ? {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uai.id}': {}
    }
  } : null
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
      // Serial log is where cloud-init failures surface — managed boot diagnostics on.
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output vmName string = vmName
output sshHint string = wantPublicIp ? 'public IP present; open temp SSH with scripts/ssh-open.ps1, then ssh ${adminUsername}@<public-ip>' : 'no public IP; tunnel-only, no SSH'
