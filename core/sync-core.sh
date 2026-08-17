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

# The manifest is GENERATED from exactly the set this script vendors -- never hand-edited.
# A hand-maintained manifest went stale twice in one session (a shared module changed, the
# manifest did not); every image built from that vendored set then failed verify-core while
# the provisioning lane reported success, and a fresh VM sat at 502 with nothing to say.
# Hashes are over LF bytes (git stores these files LF; a Windows checkout may show CRLF), so
# a manifest computed anywhere equals what the Docker build hashes. Same set, same order and
# same normalisation as provision/lib/core-manifest.js -- change one, change the other.
manifest_of() {   # $1 = source dir -> "hash  name" lines for the vendored set, C-sorted by name
  local d="$1" f n
  for f in "$d"/*.js "$d"/*.yaml "$d"/fetch-secret.sh "$d"/backup-push.sh; do
    [ -e "$f" ] && basename "$f"
  done | LC_ALL=C sort | while read -r n; do
    printf '%s  %s\n' "$(tr -d '\r' < "$d/$n" | sha256sum | cut -c1-64)" "$n"
  done
}
refresh_manifest() {   # $1 = source dir, $2 = manifest path; rewrites it; returns 1 if it was stale
  local new; new="$(manifest_of "$1")"
  if [ -f "$2" ] && [ "$(tr -d '\r' < "$2")" = "$new" ]; then return 0; fi
  printf '%s\n' "$new" > "$2"
  return 1
}
STALE=0
refresh_manifest "$HERE" "$HERE/manifest.sha256" || STALE=1
if [ -d "$HERE/gate" ]; then refresh_manifest "$HERE/gate" "$HERE/gate/manifest.sha256" || STALE=1; fi
if [ "$STALE" = 1 ]; then
  echo "REFUSING to vendor: fleet-core's committed manifest did not match core/ -- it has been REGENERATED in place."
  echo "  Commit core/manifest.sha256 (and core/gate/manifest.sha256) in agent-fleet-iac, then re-run sync-core."
  echo "  A stamp must name a commit whose manifest is true; 'npm test' in provision/ fails on this drift too."
  exit 1
fi

CORE_REF="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# Stamp honesty: a sync from a dirty tree is not that commit -- mark it.
git -C "$HERE" diff --quiet -- . 2>/dev/null || CORE_REF="${CORE_REF}+dirty"

vendor() {
  SRCDIR="$1"; DEST="$2"; MANIFEST="$3"
  [ -d "$DEST" ] || { echo "FATAL: dest not found: $DEST"; exit 1; }
  [ -f "$MANIFEST" ] || { echo "FATAL: no manifest: $MANIFEST"; exit 1; }
  echo "Syncing fleet-core ($CORE_REF) -> $DEST"
  for f in "$SRCDIR"/*.js "$SRCDIR"/*.yaml "$SRCDIR"/fetch-secret.sh "$SRCDIR"/backup-push.sh "$HERE"/verify-core.sh; do
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
# Say exactly what moved, so nothing vendored is left uncommitted: a stamp whose manifest names
# a module the commit left behind fails the next image build (a backup-push.sh vendored but not
# committed did precisely that once).
echo "Changed in $REPO -- commit ALL of these together with the stamp(s):"
git -C "$REPO" status --porcelain -- "$SCRIPTS_SUB" ${GATE_SUB:+"$GATE_SUB"} 2>/dev/null | sed 's/^/  /' || echo "  (not a git checkout -- list the vendored dirs by hand)"
echo "Done. Commit the vendored files + .fleet-core-version in the agent repo(s)."
