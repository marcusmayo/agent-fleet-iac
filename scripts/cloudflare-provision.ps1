<#
cloudflare-provision.ps1 — one-command Cloudflare front door for a fleet agent.

Automates the per-agent Cloudflare setup that was previously manual (README Part 0):
  1. Create (or reuse) a named cloudflared tunnel and fetch its token
  2. Configure the tunnel ingress: <name>.<domain> -> http://localhost:<port> (the webchat)
  3. Create the DNS CNAME to the tunnel
  4. Create (or reuse) a self-hosted Access application for that hostname
  5. Attach an allow policy scoped to a single operator email (email-code login)

It bakes in two things learned standing up bosun:
  - the app is pinned to the One-time PIN identity provider (email code), so there is
    no "sign in with Cloudflare" account picker, and it works from ANY browser
  - the App Launcher is left off, avoiding the clientless-isolation save error

The tunnel token it prints is what deploy.sh consumes as CF_TUNNEL_TOKEN. So the full
standup becomes:
    ./scripts/cloudflare-provision.ps1 -AgentName heimdall -Profile castor -OperatorEmail keel@keel-pm.com -AccountId <acct>
    $env:CF_TUNNEL_TOKEN = "<printed token>"
    bash scripts/deploy.sh <profile> <name>

Auth: set $env:CF_API_TOKEN to a token with Zero Trust + DNS edit scope. Never pass the
token as an argument (it would land in shell history). Idempotent — safe to re-run.

NOTE: authored against Cloudflare's documented API and not yet run live end-to-end;
validate once against a throwaway name and adjust any endpoint/field the API rejects.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[a-z][a-z0-9-]{1,23}$')] [string] $AgentName,
  [Parameter(Mandatory)] [string] $OperatorEmail,
  [Parameter(Mandatory)] [string] $AccountId,
  [string] $Domain = "keel-pm.com",
  [ValidateSet("castor","keel","atlas")] [string] $AgentProfile = "keel",
  [int]    $WebchatPort = 8443,
  [string] $SessionDuration = "24h",
  [switch] $IncludeSshHostname   # hardened path: also expose ssh-<name> -> ssh://localhost:22
)

$ErrorActionPreference = "Stop"
if (-not $env:CF_API_TOKEN) { throw "Set `$env:CF_API_TOKEN (Zero Trust + DNS edit scope) before running." }

$api  = "https://api.cloudflare.com/client/v4"
$hdrs = @{ Authorization = "Bearer $($env:CF_API_TOKEN)"; "Content-Type" = "application/json" }
$fqdn = "$AgentName.$Domain"

function Invoke-CF {
  param([string]$Method, [string]$Path, $Body)
  $uri = "$api$Path"
  try {
    if ($Body) {
      $json = ($Body | ConvertTo-Json -Depth 10 -Compress)
      $resp = Invoke-RestMethod -Method $Method -Uri $uri -Headers $hdrs -Body $json
    } else {
      $resp = Invoke-RestMethod -Method $Method -Uri $uri -Headers $hdrs
    }
  } catch {
    throw "CF API $Method $Path failed: $($_.Exception.Message)"
  }
  if (-not $resp.success) {
    $msg = ($resp.errors | ForEach-Object { "$($_.code): $($_.message)" }) -join "; "
    throw "CF API $Method $Path returned errors: $msg"
  }
  return $resp
}

Write-Host ">> Provisioning Cloudflare front door for '$AgentName' at https://$fqdn" -ForegroundColor Cyan

# 0. sanity: token can read the account
Invoke-CF GET "/accounts/$AccountId" | Out-Null

# 1. zone id for the domain
$zone = (Invoke-CF GET "/zones?name=$Domain").result
if (-not $zone) { throw "No Cloudflare zone found for '$Domain' on this account." }
$zoneId = $zone[0].id
Write-Host "   zone $Domain -> $zoneId"

# 2. One-time PIN identity provider id (so the app skips the account picker)
$idps = (Invoke-CF GET "/accounts/$AccountId/access/identity_providers").result
$otp  = $idps | Where-Object { $_.type -eq "onetimepin" } | Select-Object -First 1
if (-not $otp) {
  Write-Host "   One-time PIN not enabled — creating it (email-code login)" -ForegroundColor Yellow
  $otp = (Invoke-CF POST "/accounts/$AccountId/access/identity_providers" @{ type = "onetimepin"; name = "One-time PIN"; config = @{} }).result
}
$otpId = $otp.id
Write-Host "   identity provider (One-time PIN) -> $otpId"

# 3. tunnel (reuse if present)
$existing = (Invoke-CF GET "/accounts/$AccountId/cfd_tunnel?name=$AgentName&is_deleted=false").result
if ($existing) {
  $tunnelId = $existing[0].id
  Write-Host "   tunnel '$AgentName' exists -> $tunnelId (reusing)"
} else {
  $tunnelId = (Invoke-CF POST "/accounts/$AccountId/cfd_tunnel" @{ name = $AgentName; config_src = "cloudflare" }).result.id
  Write-Host "   tunnel '$AgentName' created -> $tunnelId"
}
$token = (Invoke-CF GET "/accounts/$AccountId/cfd_tunnel/$tunnelId/token").result

# 4. ingress config: webchat (+ optional ssh), catch-all 404
$ingress = @( @{ hostname = $fqdn; service = "http://localhost:$WebchatPort" } )
if ($IncludeSshHostname) { $ingress += @{ hostname = "ssh-$fqdn"; service = "ssh://localhost:22" } }
$ingress += @{ service = "http_status:404" }
Invoke-CF PUT "/accounts/$AccountId/cfd_tunnel/$tunnelId/configurations" @{ config = @{ ingress = $ingress } } | Out-Null
Write-Host "   ingress set: $fqdn -> http://localhost:$WebchatPort"

# 5. DNS CNAME(s) -> tunnel (idempotent)
function Ensure-Cname {
  param([string]$Name)
  $content = "$tunnelId.cfargotunnel.com"
  $rec = (Invoke-CF GET "/zones/$zoneId/dns_records?type=CNAME&name=$Name").result
  $body = @{ type = "CNAME"; name = $Name; content = $content; proxied = $true }
  if ($rec) {
    Invoke-CF PUT "/zones/$zoneId/dns_records/$($rec[0].id)" $body | Out-Null
    Write-Host "   DNS $Name -> $content (updated)"
  } else {
    Invoke-CF POST "/zones/$zoneId/dns_records" $body | Out-Null
    Write-Host "   DNS $Name -> $content (created)"
  }
}
Ensure-Cname $fqdn
if ($IncludeSshHostname) { Ensure-Cname "ssh-$fqdn" }

# 6. Access application (reuse by domain) — pinned to One-time PIN, launcher OFF
function Ensure-AccessApp {
  param([string]$AppHost, [string]$AppName)
  $apps = (Invoke-CF GET "/accounts/$AccountId/access/apps").result
  $app  = $apps | Where-Object { $_.domain -eq $AppHost } | Select-Object -First 1
  $body = @{
    name                    = $AppName
    domain                  = $AppHost
    type                    = "self_hosted"
    session_duration        = $SessionDuration
    app_launcher_visible    = $false          # avoids the clientless-isolation save error
    auto_redirect_to_identity = $true          # skip the provider picker
    allowed_idps            = @($otpId)        # email-code only
  }
  if ($app) {
    $id = $app.id
    Invoke-CF PUT "/accounts/$AccountId/access/apps/$id" $body | Out-Null
    Write-Host "   Access app '$AppName' ($AppHost) updated -> $id"
  } else {
    $id = (Invoke-CF POST "/accounts/$AccountId/access/apps" $body).result.id
    Write-Host "   Access app '$AppName' ($AppHost) created -> $id"
  }
  # allow policy scoped to the single operator email (idempotent by name)
  $pols = (Invoke-CF GET "/accounts/$AccountId/access/apps/$id/policies").result
  $pol  = $pols | Where-Object { $_.name -eq "$AppName-operator" } | Select-Object -First 1
  $pbody = @{ name = "$AppName-operator"; decision = "allow"; include = @(@{ email = @{ email = $OperatorEmail } }) }
  if ($pol) {
    Invoke-CF PUT "/accounts/$AccountId/access/apps/$id/policies/$($pol.id)" $pbody | Out-Null
    Write-Host "   policy '$AppName-operator' allow $OperatorEmail (updated)"
  } else {
    Invoke-CF POST "/accounts/$AccountId/access/apps/$id/policies" $pbody | Out-Null
    Write-Host "   policy '$AppName-operator' allow $OperatorEmail (created)"
  }
}
Ensure-AccessApp $fqdn $AgentName
if ($IncludeSshHostname) { Ensure-AccessApp "ssh-$fqdn" "$AgentName-ssh" }

# 7. done — hand off to deploy.sh
Write-Host ""
Write-Host "Cloudflare front door ready for $AgentName." -ForegroundColor Green
Write-Host "Next (do NOT paste the token anywhere public):" -ForegroundColor Green
Write-Host "    `$env:CF_TUNNEL_TOKEN = `"$token`""
Write-Host "    bash scripts/deploy.sh $AgentProfile $AgentName"
Write-Host ""
Write-Host "After deploy + bootstrap, reach it at:  https://$fqdn" -ForegroundColor Green
if ($IncludeSshHostname) {
  Write-Host "Hardened SSH (no public IP):  ssh -o ProxyCommand=`"cloudflared access ssh --hostname ssh-$fqdn`" agentadmin@ssh-$fqdn"
}
