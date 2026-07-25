using '../main.bicep'

// Keel profile — portfolio-management engine (deterministic WSJF/RICE tools,
// backlog normalize/reconcile, Excel round-trip). Same image as Castor; the
// profile toggles which skills/interfaces are active.
// Values come from environment variables set by scripts/deploy.sh.

param agentName = readEnvironmentVariable('AGENT_NAME', 'helm')
param agentProfile = 'keel'
param location = readEnvironmentVariable('AZ_LOCATION', 'eastus2')
param vmSize = readEnvironmentVariable('VM_SIZE', 'Standard_D2s_v3')
param adminUsername = readEnvironmentVariable('ADMIN_USER', 'agentadmin')
param sshPublicKey = readEnvironmentVariable('SSH_PUBKEY', '')
param sshAccessCidr = readEnvironmentVariable('SSH_CIDR', '')
param cloudflareTunnelToken = readEnvironmentVariable('CF_TUNNEL_TOKEN', '')
param repoUrl = readEnvironmentVariable('REPO_URL', 'https://github.com/marcusmayo/keel-portfolio-management.git')
param repoRef = readEnvironmentVariable('REPO_REF', '')
