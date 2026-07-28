<#
ssh-open.ps1 - temporarily open SSH to a fleet agent's VM from YOUR CURRENT IP ONLY.
Adds an inbound NSG rule (port 22, source = your /32), then prints the exact ssh command.
Run ssh-close.ps1 the moment you're done to return it to zero-inbound. Idempotent.
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

$myip = (Invoke-WebRequest -UseBasicParsing "https://ifconfig.me/ip").Content.Trim()
Write-Host ">> Opening SSH to $AgentName from $myip/32 only" -ForegroundColor Cyan

$exists = az network nsg rule show -g $rg --nsg-name $nsg -n $rule --query "name" -o tsv 2>$null
if ($exists) {
  az network nsg rule update -g $rg --nsg-name $nsg -n $rule --source-address-prefixes "$myip/32" | Out-Null
  Write-Host "   rule '$rule' updated -> source $myip/32"
} else {
  az network nsg rule create -g $rg --nsg-name $nsg -n $rule --priority $Priority --direction Inbound --access Allow --protocol Tcp --destination-port-ranges 22 --source-address-prefixes "$myip/32" --destination-address-prefixes '*' --source-port-ranges '*' | Out-Null
  Write-Host "   rule '$rule' created (priority $Priority) -> source $myip/32"
}

$pubip = az vm list-ip-addresses -g $rg --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv 2>$null
if (-not $pubip) {
  Write-Host "   No public IP on $AgentName - deployed hardened (tunnel-only)." -ForegroundColor Yellow
} else {
  Write-Host ""
  Write-Host "SSH is open. Connect with:" -ForegroundColor Green
  Write-Host "    ssh -i `"`$env:USERPROFILE\.ssh\$SshKey`" $AdminUser@$pubip"
  Write-Host ""
  Write-Host "Close it when done:  ./scripts/ssh-close.ps1 -AgentName $AgentName" -ForegroundColor Green
}
