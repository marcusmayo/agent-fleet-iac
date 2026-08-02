#!/usr/bin/env bash
# sync-core.sh -- vendor fleet-core's canonical shared modules into an agent repo.
# Lives in agent-fleet-iac/core/. Run from an agent-fleet-iac checkout.
#
# Usage:  ./core/sync-core.sh <agent-repo-root> <dest-subdir>
#   e.g.  ./core/sync-core.sh ~/castor                    scaffold/scripts
#         ./core/sync-core.sh ~/keel-portfolio-management scripts
#
# Vendors the shared .js module(s) + verify-core.sh into <agent-repo-root>/<dest-subdir>/,
# then writes a .fleet-core-version stamp (agent-fleet-iac commit + the manifest hashes).
# The agent repo commits the vendored files + stamp; its Dockerfile runs the vendored
# verify-core.sh so a drifted copy fails the build loud.
set -euo pipefail
REPO="${1:?usage: sync-core.sh <agent-repo-root> <dest-subdir>}"
DEST_SUB="${2:?usage: sync-core.sh <agent-repo-root> <dest-subdir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"        # the core/ dir
DEST="$REPO/$DEST_SUB"
[ -d "$HERE" ] || { echo "FATAL: core dir not found: $HERE"; exit 1; }
[ -d "$DEST" ] || { echo "FATAL: dest not found: $DEST"; exit 1; }
[ -f "$HERE/manifest.sha256" ] || { echo "FATAL: no manifest.sha256 in $HERE"; exit 1; }
CORE_REF="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "Syncing fleet-core ($CORE_REF) -> $DEST"
for f in "$HERE"/*.js "$HERE"/verify-core.sh; do
  [ -e "$f" ] || continue
  cp "$f" "$DEST/$(basename "$f")"
  echo "  vendored: $(basename "$f")"
done
{
  echo "# fleet-core sync stamp -- do not edit by hand"
  echo "fleet_core_commit: $CORE_REF"
  echo "synced_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "manifest:"
  sed 's/^/  /' "$HERE/manifest.sha256"
} > "$DEST/.fleet-core-version"
echo "  stamp: $DEST/.fleet-core-version (core=$CORE_REF)"
echo "Done. Commit the vendored files + .fleet-core-version in the agent repo."
