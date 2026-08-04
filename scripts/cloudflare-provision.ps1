<#
cloudflare-provision.ps1 - one-command Cloudflare front door for a fleet agent.
Creates/reuses: named tunnel (+token), ingress to the webchat, DNS CNAME, Access app
pinned to One-time PIN (email-code login, no account picker), operator-email policy.
App Launcher stays off (avoids the clientless-isolation save error).
Auth: set $env:CF_API_TOKEN (Zero Trust + DNS edit). Idempotent - safe to re-run.
The printed tunnel token is what deploy.sh consumes as CF_TUNNEL_TOKEN.
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
  [string] $TokenOutFile = "",
  [switch] $EnableSsh
)

$ErrorActionPreference = "Stop"
if (-not $env:CF_API_TOKEN) { throw "Set `$env:CF_API_TOKEN (Zero Trust + DNS edit scope) before running." }

$api  = "https://api.cloudflare.com/client/v4"
$hdrs = @{ Authorization = "Bearer $($env:CF_API_TOKEN)"; "Content-Type" = "application/json" }
$fqdn = "$AgentName.$Domain"
$sshHost = "ssh-$AgentName.$Domain"

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

try { Invoke-CF GET "/accounts/$AccountId" | Out-Null } catch { Write-Host "   (account-read denied - continuing)" -ForegroundColor Yellow }

$zone = (Invoke-CF GET "/zones?name=$Domain").result
if (-not $zone) { throw "No Cloudflare zone found for '$Domain' on this account." }
$zoneId = $zone[0].id
Write-Host "   zone $Domain -> $zoneId"

$idps = (Invoke-CF GET "/accounts/$AccountId/access/identity_providers").result
$otp  = $idps | Where-Object { $_.type -eq "onetimepin" } | Select-Object -First 1
if (-not $otp) {
  Write-Host "   One-time PIN not enabled - creating it (email-code login)" -ForegroundColor Yellow
  $otp = (Invoke-CF POST "/accounts/$AccountId/access/identity_providers" @{ type = "onetimepin"; name = "One-time PIN"; config = @{} }).result
}
$otpId = $otp.id
Write-Host "   identity provider (One-time PIN) -> $otpId"

$existing = (Invoke-CF GET "/accounts/$AccountId/cfd_tunnel?name=$AgentName").result | Where-Object { -not $_.deleted_at } | Select-Object -First 1
if ($existing) {
  $tunnelId = $existing.id
  Write-Host "   tunnel '$AgentName' exists -> $tunnelId (reusing)"
} else {
  $tunnelId = (Invoke-CF POST "/accounts/$AccountId/cfd_tunnel" @{ name = $AgentName; config_src = "cloudflare" }).result.id
  Write-Host "   tunnel '$AgentName' created -> $tunnelId"
}
$token = (Invoke-CF GET "/accounts/$AccountId/cfd_tunnel/$tunnelId/token").result

$ingress = @( @{ hostname = $fqdn; service = "http://localhost:$WebchatPort" } )
if ($EnableSsh) { $ingress += @{ hostname = $sshHost; service = "ssh://localhost:22" } }
$ingress += @{ service = "http_status:404" }
Invoke-CF PUT "/accounts/$AccountId/cfd_tunnel/$tunnelId/configurations" @{ config = @{ ingress = $ingress } } | Out-Null
Write-Host "   ingress set: $fqdn -> http://localhost:$WebchatPort"
if ($EnableSsh) { Write-Host "   ingress set: $sshHost -> ssh://localhost:22" }

function Ensure-Cname {
  param([string]$Name)
  $content = "$tunnelId.cfargotunnel.com"
  $rec = (Invoke-CF GET "/zones/$zoneId/dns_records?name=$Name").result | Where-Object { $_.type -eq "CNAME" } | Select-Object -First 1
  $body = @{ type = "CNAME"; name = $Name; content = $content; proxied = $true }
  if ($rec) {
    Invoke-CF PUT "/zones/$zoneId/dns_records/$($rec.id)" $body | Out-Null
    Write-Host "   DNS $Name -> $content (updated)"
  } else {
    Invoke-CF POST "/zones/$zoneId/dns_records" $body | Out-Null
    Write-Host "   DNS $Name -> $content (created)"
  }
}
Ensure-Cname $fqdn
if ($EnableSsh) { Ensure-Cname $sshHost }

function Ensure-AccessApp {
  param([string]$AppHost, [string]$AppName)
  $apps = (Invoke-CF GET "/accounts/$AccountId/access/apps").result
  $app  = $apps | Where-Object { $_.domain -eq $AppHost } | Select-Object -First 1
  $body = @{
    name                      = $AppName
    domain                    = $AppHost
    type                      = "self_hosted"
    session_duration          = $SessionDuration
    app_launcher_visible      = $false
    auto_redirect_to_identity = $true
    allowed_idps              = @($otpId)
  }
  if ($app) {
    $id = $app.id
    Invoke-CF PUT "/accounts/$AccountId/access/apps/$id" $body | Out-Null
    Write-Host "   Access app '$AppName' ($AppHost) updated -> $id"
  } else {
    $id = (Invoke-CF POST "/accounts/$AccountId/access/apps" $body).result.id
    Write-Host "   Access app '$AppName' ($AppHost) created -> $id"
  }
  $pols = (Invoke-CF GET "/accounts/$AccountId/access/apps/$id/policies").result
  $pol  = $pols | Where-Object { $_.name -eq "$AppName-operator" } | Select-Object -First 1
  $pbody = @{ name = "$AppName-operator"; decision = "allow"; include = @(@{ email = @{ email = $OperatorEmail } }) }
  if ($pol) {
    # PUT-in-place 400s under Cloudflare's reusable-policy migration; delete + recreate
    # is idempotent and always POSTs the shape the API currently expects.
    Invoke-CF DELETE "/accounts/$AccountId/access/apps/$id/policies/$($pol.id)" | Out-Null
    Invoke-CF POST "/accounts/$AccountId/access/apps/$id/policies" $pbody | Out-Null
    Write-Host "   policy '$AppName-operator' allow $OperatorEmail (replaced)"
  } else {
    Invoke-CF POST "/accounts/$AccountId/access/apps/$id/policies" $pbody | Out-Null
    Write-Host "   policy '$AppName-operator' allow $OperatorEmail (created)"
  }
}
Ensure-AccessApp $fqdn $AgentName
if ($EnableSsh) { Ensure-AccessApp $sshHost "$AgentName-ssh" }

# For non-interactive callers (fleetctl up): emit the tunnel token to a file only
# after every CF step above succeeded. The caller reads it, then deletes it.
if ($TokenOutFile) {
  Set-Content -Path $TokenOutFile -Value $token -NoNewline -Encoding ascii
  Write-Host "   tunnel token written to $TokenOutFile (delete after use)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Cloudflare front door ready for $AgentName." -ForegroundColor Green
Write-Host "Next (do NOT paste the token anywhere public):" -ForegroundColor Green
Write-Host "    `$env:CF_TUNNEL_TOKEN = `"$token`""
Write-Host "    bash scripts/deploy.sh $AgentProfile $AgentName"
Write-Host ""
Write-Host "After deploy + bootstrap, reach it at:  https://$fqdn" -ForegroundColor Green
if ($EnableSsh) {
  Write-Host "SSH over the tunnel (no public IP):     ./scripts/ssh-tunnel.ps1 -AgentName $AgentName" -ForegroundColor Green
}
