using '../main.bicep'

// Castor profile — multi-interface assistant (webchat + Telegram + email intake).
// Values come from environment variables set by scripts/deploy.sh so that
// secrets and per-run values are NEVER committed to source control.

param agentName = readEnvironmentVariable('AGENT_NAME', 'castor')
param agentProfile = 'castor'
param location = readEnvironmentVariable('AZ_LOCATION', 'eastus2')
param vmSize = readEnvironmentVariable('VM_SIZE', 'Standard_D2s_v3')
param adminUsername = readEnvironmentVariable('ADMIN_USER', 'agentadmin')
param sshPublicKey = readEnvironmentVariable('SSH_PUBKEY', '')
param sshAccessCidr = readEnvironmentVariable('SSH_CIDR', '')
param cloudflareTunnelToken = readEnvironmentVariable('CF_TUNNEL_TOKEN', '')
param repoUrl = readEnvironmentVariable('REPO_URL', 'https://github.com/marcusmayo/castor.git')
param repoRef = readEnvironmentVariable('REPO_REF', '')
param deployerObjectId = readEnvironmentVariable('DEPLOYER_OBJECT_ID', '')
