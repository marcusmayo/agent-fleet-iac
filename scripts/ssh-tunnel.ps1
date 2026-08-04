<#
ssh-tunnel.ps1 - SSH into an agent over its Cloudflare tunnel, no public IP required.

Prereqs:
  1. The agent was provisioned (or re-run) with -EnableSsh on cloudflare-provision.ps1,
     which adds an ssh-<agent>.<domain> hostname, its Access app, and an
     ssh://localhost:22 ingress rule. Because tunnels use config_src=cloudflare, the
     running connector picks up that ingress with no change to the VM.
  2. cloudflared is installed on THIS workstation:
     https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  3. The VM's sshd is running and your key is authorized (same key deploy.sh installed).

This routes the SSH stream through the tunnel via a ProxyCommand; a browser opens once
for Cloudflare Access (email one-time PIN) to authorize the session.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[a-z][a-z0-9-]{1,23}$')] [string] $AgentName,
  [string] $Domain    = "keel-pm.com",
  [string] $AdminUser = "agentadmin",
  [string] $SshKey    = "keel_t2"
)
$ErrorActionPreference = "Stop"
$sshHost = "ssh-$AgentName.$Domain"

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "cloudflared not found on PATH. Install it, then re-run:" -ForegroundColor Yellow
  Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
}
$key = Join-Path $env:USERPROFILE ".ssh\$SshKey"
if (-not (Test-Path $key)) { Write-Host "SSH key not found: $key" -ForegroundColor Yellow; exit 1 }

Write-Host ">> SSH to $AgentName over the tunnel ($sshHost) - a browser may open for Access login" -ForegroundColor Cyan
Write-Host "   (no public IP is used; the stream is proxied through cloudflared)" -ForegroundColor DarkGray

# %h expands to the target host; cloudflared proxies the connection to the tunnel origin.
& ssh -o "ProxyCommand=cloudflared access ssh --hostname %h" -i "$key" "$AdminUser@$sshHost"
