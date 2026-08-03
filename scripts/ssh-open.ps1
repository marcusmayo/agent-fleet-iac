<#
ssh-open.ps1 - temporarily open SSH to a fleet agent's VM from YOUR CURRENT IP ONLY.
Adds an inbound NSG rule (port 22, source = your /32), then prints the exact ssh command.
Run ssh-close.ps1 the moment you're done to return it to zero-inbound. Idempotent.
Works under Windows PowerShell 5.1 and pwsh 7 (native stderr is probed EAP-safely).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[a-z][a-z0-9-]{1,23}$')] [string] $AgentName,
  [string] $SshKey    = "keel_t2",
  [string] $AdminUser = "agentadmin",
  [int]    $Priority  = 300
)
$ErrorActionPreference = "Stop"
$rg   = "rg-$AgentName"
$nsg  = "$AgentName-nsg"
$rule = "allow-ssh-bootstrap"

# Probe an az query without dying under PS 5.1 + EAP=Stop (2>$null there turns
# native stderr into a terminating error). Returns stdout or $null.
function Probe-Az {
  param([string[]] $AzArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try   { $out = az @AzArgs 2>$null }
  finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { return $null }
  return $out
}

# A public IP must exist BEFORE we touch the NSG - a hardened (tunnel-only) agent
# has none, and an allow rule with nothing behind it is just clutter.
$pubip = Probe-Az @('vm','list-ip-addresses','-g',$rg,'--query','[0].virtualMachine.network.publicIpAddresses[0].ipAddress','-o','tsv')
if (-not $pubip) {
  Write-Host ">> $AgentName has NO public IP (hardened, tunnel-only) - nothing to open." -ForegroundColor Yellow
  Write-Host "   Options:" -ForegroundColor Yellow
  Write-Host "     a) redeploy with `"sshCidr`": `"<your-ip>/32`" in its contract (creates a temp-SSH public IP), or"
  Write-Host "     b) use the cloudflared SSH path: a second tunnel hostname ssh-$AgentName.<domain> -> ssh://localhost:22"
  Write-Host "        plus an Access app, then: cloudflared access ssh --hostname ssh-$AgentName.<domain>"
  exit 1
}

$myip = (Invoke-WebRequest -UseBasicParsing "https://ifconfig.me/ip").Content.Trim()
Write-Host ">> Opening SSH to $AgentName from $myip/32 only" -ForegroundColor Cyan

$exists = Probe-Az @('network','nsg','rule','show','-g',$rg,'--nsg-name',$nsg,'-n',$rule,'--query','name','-o','tsv')
if ($exists) {
  az network nsg rule update -g $rg --nsg-name $nsg -n $rule --source-address-prefixes "$myip/32" | Out-Null
  Write-Host "   rule '$rule' updated -> source $myip/32"
} else {
  az network nsg rule create -g $rg --nsg-name $nsg -n $rule --priority $Priority --direction Inbound --access Allow --protocol Tcp --destination-port-ranges 22 --source-address-prefixes "$myip/32" --destination-address-prefixes '*' --source-port-ranges '*' | Out-Null
  Write-Host "   rule '$rule' created (priority $Priority) -> source $myip/32"
}

Write-Host ""
Write-Host "SSH is open. Connect with:" -ForegroundColor Green
Write-Host "    ssh -i `"`$env:USERPROFILE\.ssh\$SshKey`" $AdminUser@$pubip"
Write-Host ""
Write-Host "Close it when done:  ./scripts/ssh-close.ps1 -AgentName $AgentName" -ForegroundColor Green
