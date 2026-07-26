#!/usr/bin/env bash
# Deploy ONE agent VM (its own resource group).
# Usage:  scripts/deploy.sh <castor|keel> <agentName>
# Requires env: CF_TUNNEL_TOKEN, SSH_PUBKEY   (SSH_CIDR optional, AZ_LOCATION optional)
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:?usage: deploy.sh <castor|keel> <agentName>}"
NAME="${2:?usage: deploy.sh <castor|keel> <agentName>}"
case "$PROFILE" in
  castor|keel) ;;
  *) echo "ABORT: profile must be 'castor' or 'keel'"; exit 1 ;;
esac
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,23}$ ]] || { echo "ABORT: agentName must be lowercase [a-z0-9-], 2-24 chars"; exit 1; }

: "${CF_TUNNEL_TOKEN:?set CF_TUNNEL_TOKEN — the Cloudflare Tunnel token for this agent}"
: "${SSH_PUBKEY:?set SSH_PUBKEY — contents of your .pub file}"
command -v az >/dev/null || { echo "ABORT: az CLI not found"; exit 1; }

export AGENT_NAME="$NAME"
export CF_TUNNEL_TOKEN SSH_PUBKEY
export SSH_CIDR="${SSH_CIDR:-}"
export AZ_LOCATION="${AZ_LOCATION:-eastus2}"
# REPO_URL/REPO_REF: pass through only if the caller set them; otherwise the
# per-profile bicepparam default applies (keel -> keel repo, castor -> castor repo).
if [ -n "${REPO_URL:-}" ]; then export REPO_URL; fi
if [ -n "${REPO_REF:-}" ]; then export REPO_REF; fi

# Castor's per-agent Key Vault grants the deployer 'Key Vault Secrets Officer' so
# you can set the operator secrets post-apply. Resolve the signed-in user's object
# id (override DEPLOYER_OBJECT_ID for service-principal deploys). Empty is fine —
# the raKvSecretsOfficer assignment is simply skipped and can be granted manually.
if [ "$PROFILE" = "castor" ] && [ -z "${DEPLOYER_OBJECT_ID:-}" ]; then
  DEPLOYER_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
fi
export DEPLOYER_OBJECT_ID="${DEPLOYER_OBJECT_ID:-}"

echo ">> Deploying agent '$NAME' (profile: $PROFILE) to $AZ_LOCATION"
[ -n "$REPO_REF" ] && echo ">> Pinned build ref: $REPO_REF" || echo ">> Build ref: default-branch HEAD"
[ -n "$SSH_CIDR" ] && echo ">> SSH bootstrap open from: $SSH_CIDR (public IP created)" \
                   || echo ">> No public IP — hardened, tunnel-only (SSH over cloudflared)"

az deployment sub create \
  --name "deploy-${NAME}-$(date +%Y%m%d%H%M%S)" \
  --location "$AZ_LOCATION" \
  --parameters "bicep/params/${PROFILE}.bicepparam" \
  --query "{rg:properties.outputs.resourceGroup.value, profile:properties.outputs.profile.value, publicIp:properties.outputs.publicIpEnabled.value, privateIp:properties.outputs.privateIp.value}" \
  -o jsonc

echo ">> Provisioned. cloud-init is now building the image on the VM (~4-8 min)."
echo ">> Next: SSH in, tail /var/log/agent-image-build.log, then run infra/scripts/bootstrap.sh"
