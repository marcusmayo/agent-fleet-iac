#!/usr/bin/env bash
# Decommission ONE agent: delete its resource group (VM, disk, NIC, NSG, VNet, IP).
# Usage:  scripts/decommission.sh <agentName> [--yes]
#         FLEET_YES=1 scripts/decommission.sh <agentName>   # non-interactive (used by the Aegis endpoint)
set -euo pipefail

NAME="${1:?usage: decommission.sh <agentName> [--yes]}"
RG="rg-${NAME}"
command -v az >/dev/null || { echo "ABORT: az CLI not found"; exit 1; }

if [ "${2:-}" = "--yes" ] || [ "${FLEET_YES:-}" = "1" ]; then
  CONFIRM="$NAME"
else
  echo "This will DELETE resource group '$RG' and everything in it."
  read -r -p "Type the agent name '$NAME' to confirm: " CONFIRM
fi
[ "$CONFIRM" = "$NAME" ] || { echo "ABORT: confirmation did not match"; exit 1; }

echo ">> Deleting $RG ..."
az group delete --name "$RG" --yes
echo ">> Azure resources deleted."
echo ""
echo ">> MANUAL follow-up (outside Azure) to fully offboard this agent:"
echo "     1. Cloudflare Zero Trust: delete this agent's Tunnel + Access app(s)."
echo "     2. Model provider: revoke this agent's LiteLLM / OpenRouter key."
echo "     3. Aegis: remove the agent's registry entry (deregister)."
