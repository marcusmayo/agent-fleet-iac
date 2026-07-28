#!/usr/bin/env bash
# set-secrets.sh - set the per-agent operator secrets in the agent's Key Vault
# with fail-loud SHAPE VALIDATION, so a placeholder (e.g. "<OpenRouter key>") or a
# wrong key can never reach the vault. This is the deploy-time structural guard;
# bootstrap.sh re-checks the OpenRouter key shape before compose up (defense in
# depth). Chat #18 root cause: a raw "az keyvault secret set --value <placeholder>"
# stored the literal placeholder, which reached OpenRouter as no auth header (401).
#
# Usage:  scripts/set-secrets.sh <resourceGroup>        # e.g. rg-heimdall
# Prompts (no echo) for each key, validates the prefix, then sets it. Values are
# never echoed, never passed as args, and never written to shell history.
set -euo pipefail

RG="${1:?usage: set-secrets.sh <resourceGroup>  (e.g. rg-heimdall)}"
command -v az >/dev/null || { echo "ABORT: az CLI not found"; exit 1; }

KV="$(az keyvault list -g "$RG" --query '[0].name' -o tsv 2>/dev/null || true)"
[ -n "$KV" ] || { echo "ABORT: no Key Vault found in resource group '$RG'"; exit 1; }
echo ">> vault: $KV"

# set_secret <secret-name> <required-prefix> <human-label>
set_secret() {
  local name="$1" prefix="$2" label="$3" val=""
  read -rs -p "Enter $label (must start with '$prefix'): " val; echo
  case "$val" in
    "")         echo "ABORT: $name is empty. Nothing was set."; exit 1 ;;
    "$prefix"*) : ;;
    *)          echo "ABORT: $name must start with '$prefix' - got a placeholder or wrong key. Nothing was set."; exit 1 ;;
  esac
  az keyvault secret set --vault-name "$KV" --name "$name" --value "$val" --output none
  printf '  set %-16s %s...\n' "$name" "$(printf '%s' "$val" | cut -c1-8)"
}

set_secret model-api-key  "sk-or-"  "OpenRouter model key"
set_secret vision-api-key "sk-ant-" "Anthropic vision key"
echo ">> secrets set with validated shapes. Next: SSH in and run infra/scripts/bootstrap.sh"
