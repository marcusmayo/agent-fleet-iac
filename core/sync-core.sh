#!/usr/bin/env bash
# sync-core.sh -- vendor fleet-core's canonical shared modules into an agent repo.
# Lives in agent-fleet-iac/core/. Run from an agent-fleet-iac checkout.
#
# Usage:  ./core/sync-core.sh <agent-repo-root> <scripts-dest> [gate-dest]
#   e.g.  ./core/sync-core.sh ~/castor                    scaffold/scripts scaffold/gate
#         ./core/sync-core.sh ~/keel-portfolio-management scripts          gate
#
# Vendors core/*.js (+ fetch-secret.sh + verify-core.sh + a stamp) into <scripts-dest>,
# and if a <gate-dest> is given, core/gate/*.js (+ verify-core.sh + a stamp) into it too.
# Each dest gets its own .fleet-core-version carrying its manifest; each agent
# Dockerfile runs verify-core.sh against each dest to fail-loud on drift.
set -euo pipefail
REPO="${1:?usage: sync-core.sh <agent-repo-root> <scripts-dest> [gate-dest]}"
SCRIPTS_SUB="${2:?usage: sync-core.sh <agent-repo-root> <scripts-dest> [gate-dest]}"
GATE_SUB="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"        # the core/ dir
[ -d "$HERE" ] || { echo "FATAL: core dir not found: $HERE"; exit 1; }
CORE_REF="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"

vendor() {
  SRCDIR="$1"; DEST="$2"; MANIFEST="$3"
  [ -d "$DEST" ] || { echo "FATAL: dest not found: $DEST"; exit 1; }
  [ -f "$MANIFEST" ] || { echo "FATAL: no manifest: $MANIFEST"; exit 1; }
  echo "Syncing fleet-core ($CORE_REF) -> $DEST"
  for f in "$SRCDIR"/*.js "$SRCDIR"/*.yaml "$SRCDIR"/fetch-secret.sh "$HERE"/verify-core.sh; do
    [ -e "$f" ] || continue
    cp "$f" "$DEST/$(basename "$f")"
    echo "  vendored: $(basename "$f")"
  done
  {
    echo "# fleet-core sync stamp -- do not edit by hand"
    echo "fleet_core_commit: $CORE_REF"
    echo "synced_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "manifest:"
    sed 's/^/  /' "$MANIFEST"
  } > "$DEST/.fleet-core-version"
  echo "  stamp: $DEST/.fleet-core-version (core=$CORE_REF)"
}

vendor "$HERE" "$REPO/$SCRIPTS_SUB" "$HERE/manifest.sha256"
if [ -n "$GATE_SUB" ]; then
  [ -d "$HERE/gate" ] || { echo "FATAL: no core/gate dir at $HERE/gate"; exit 1; }
  vendor "$HERE/gate" "$REPO/$GATE_SUB" "$HERE/gate/manifest.sha256"
fi
echo "Done. Commit the vendored files + .fleet-core-version in the agent repo(s)."
