// vm.bicep — network + compute for one agent.
// Posture: NO public IP unless sshAccessCidr is set (a bootstrap convenience).
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

var vmName = '${agentName}-vm'
var useSsh = !empty(sshAccessCidr)

// cloud-init: one file, placeholders replaced at deploy time. The tunnel token is
// the only secret in customData and is scrubbed from cloud logs after install;
// runtime secrets (TOTP, model key) are injected later via bootstrap over SSH.
var ciRaw = loadTextContent('../cloud-init/agent-cloudflared.yaml')
var ciFinal = replace(replace(replace(replace(replace(ciRaw, '__CF_TUNNEL_TOKEN__', cloudflareTunnelToken), '__AGENT_PROFILE__', agentProfile), '__ADMIN_USER__', adminUsername), '__REPO_URL__', repoUrl), '__REPO_REF__', repoRef)

var sshAllowRule = [
  {
    name: 'allow-ssh-bootstrap'
    properties: {
      priority: 1000
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: sshAccessCidr
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '22'
    }
  }
]
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
    securityRules: concat(useSsh ? sshAllowRule : [], denyAllRule)
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

resource pip 'Microsoft.Network/publicIPAddresses@2023-11-01' = if (useSsh) {
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
          publicIPAddress: useSsh ? { id: pip.id } : null
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
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
output sshHint string = useSsh ? 'ssh ${adminUsername}@<public-ip> (see portal / az)' : 'no public IP — SSH over the Cloudflare tunnel'
