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
@minLength(1)
param repoUrl string
param repoRef string
param deployerObjectId string = ''

// Fleet backup store account name ('' = backups off; agent-side timer no-ops).
param backupAccount string = ''

var vmName = '${agentName}-vm'
var wantPublicIp = !empty(sshAccessCidr)

// --- Vault + identity (ALL profiles) and blob backup (Castor only) ---
// EVERY agent now gets a per-agent Key Vault + user-assigned managed identity so it
// can fetch its runtime secrets non-interactively at first boot (managed identity ->
// Key Vault Secrets User, READ-ONLY). No secrets are created here; the deployer seeds
// them post-apply via `az keyvault secret set`, and bootstrap.sh fetches them with a
// retry loop to absorb RBAC propagation lag (Bicep has no time_sleep equivalent).
// There is no per-agent backup account any more. One was created for every castor-profile
// agent -- a storage account, a blob service, a 'backups' container and a role assignment --
// and nothing ever wrote to it: agents back up to the FLEET store (rg-fleet-backups, one
// container per agent, wired post-deploy by backup.ensureAgentBackup), whose name arrives as
// __BACKUP_ACCOUNT__ in .provision-flags. Provisioning a castor agent therefore built a second,
// empty, billable store it would never touch. Removed rather than left dormant: a resource that
// exists is a resource someone eventually believes in.
var wantsVault = true
var suffix = substring(uniqueString(subscription().id, agentName), 0, 5)
var kvName = '${agentName}-kv-${suffix}'
var uaiName = '${agentName}-identity'
// Built-in role definition GUIDs (stable across clouds).
var roleKvSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var roleKvSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

// cloud-init: one file, placeholders replaced at deploy time. The tunnel token is
// the only secret in customData and is scrubbed from cloud logs after install.
// For EVERY agent the vault name and MI client id are written into .provision-flags
// so bootstrap.sh can fetch runtime secrets via a non-interactive managed-identity
// call (no key on disk).
var ciRaw = loadTextContent('../cloud-init/agent-cloudflared.yaml')
var kvNameForCi = wantsVault ? kvName : ''
var msiClientIdForCi = wantsVault ? uai!.properties.clientId : ''
var ciFinal = replace(replace(replace(replace(replace(replace(replace(replace(replace(ciRaw, '__CF_TUNNEL_TOKEN__', cloudflareTunnelToken), '__AGENT_PROFILE__', agentProfile), '__ADMIN_USER__', adminUsername), '__REPO_URL__', repoUrl), '__REPO_REF__', repoRef), '__KEY_VAULT_NAME__', kvNameForCi), '__MSI_CLIENT_ID__', msiClientIdForCi), '__AGENT_NAME__', agentName), '__BACKUP_ACCOUNT__', backupAccount)

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

// --- Managed identity + per-agent Key Vault (all profiles); identity-based backup (Castor) ---
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


// identity -> read secrets.
// This assignment is BEST-EFFORT and is verified after the deploy by `up` (ensureVaultRoles),
// which is the layer that can actually guarantee it. Why: the name is a deterministic guid, and
// on a re-provision every input to it is unchanged (same vault name, same identity name), so ARM
// matches the previous deployment's assignment and reports success while the NEW principal --
// a different object under the same name -- holds nothing. The agent then 403s reading its own
// vault at first boot. Seeding the guid with deployment() does not fix it either: inside a
// module, deployment().name is the module's own name ('<agent>-vm-deploy'), constant per agent.
// Role-assignment names must be computable before deployment, so the principal id cannot seed
// them. The reconciliation therefore lives in up.js, where the principal can be read back.
resource raKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (wantsVault) {
  name: guid(kv.id, uaiName, roleKvSecretsUser)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsUser)
    principalId: uai!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}


// deployer -> create the operator secrets post-apply (az keyvault secret set)
resource raKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (wantsVault && !empty(deployerObjectId)) {
  // best-effort; reconciled post-deploy by up.js (ensureVaultRoles) for the same reason
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
