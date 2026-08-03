<#
ssh-close.ps1 - remove the temporary SSH rule, returning the agent to ZERO INBOUND. Idempotent.
Works under Windows PowerShell 5.1 and pwsh 7 (native stderr is probed EAP-safely).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[a-z][a-z0-9-]{1,23}$')] [string] $AgentName
)
$ErrorActionPreference = "Stop"
$rg   = "rg-$AgentName"
$nsg  = "$AgentName-nsg"
$rule = "allow-ssh-bootstrap"

$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try   { $exists = az network nsg rule show -g $rg --nsg-name $nsg -n $rule --query "name" -o tsv 2>$null }
finally { $ErrorActionPreference = $prev }
if ($LASTEXITCODE -ne 0 -or -not $exists) {
  Write-Host "No '$rule' rule on $AgentName - already closed (zero inbound)." -ForegroundColor Green
  return
}
az network nsg rule delete -g $rg --nsg-name $nsg -n $rule | Out-Null
Write-Host "SSH closed for $AgentName - only deny-all-inbound remains (zero inbound)." -ForegroundColor Green
