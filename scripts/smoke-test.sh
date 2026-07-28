#!/usr/bin/env bash
# Functional smoke test for one agent. Run ON the VM (over SSH) for the full set,
# or pass a reachable webchat URL to run the HTTP check from anywhere.
# Usage:  scripts/smoke-test.sh [webchatUrl] [containerName]
set -uo pipefail
URL="${1:-http://127.0.0.1:8443}"
CONTAINER="${2:-}"
pass=0; fail=0; skip=0
ok(){ echo "  PASS  $1"; pass=$((pass+1)); }
no(){ echo "  FAIL  $1"; fail=$((fail+1)); }
sk(){ echo "  SKIP  $1 ($2)"; skip=$((skip+1)); }

echo "== smoke test: $URL =="

if curl -fsS --max-time 10 "$URL" -o /dev/null 2>/dev/null; then ok "webchat responds"; else no "webchat responds"; fi

if command -v docker >/dev/null 2>&1; then
  if [ -z "$CONTAINER" ]; then
    CONTAINER="$(sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^(keel|castor|atlas)-webchat$' | head -1)"
  fi
  if [ -z "$CONTAINER" ]; then
    no "no (keel|castor|atlas)-webchat container running"
  else
    echo "  ..    container: $CONTAINER"
    if sudo docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | grep -q running; then ok "container running"; else no "container running"; fi
    if curl -fsS --max-time 10 "http://127.0.0.1:8443/health/liveliness" -o /dev/null 2>/dev/null; then ok "liveliness 200"; else no "liveliness 200"; fi
    if sudo docker exec "$CONTAINER" sh -c 'touch /app/state/.smoke && rm -f /app/state/.smoke' 2>/dev/null; then ok "state volume writable"; else no "state volume writable"; fi
    if sudo docker exec "$CONTAINER" sh -c 'test -d /app/knowledge' 2>/dev/null; then ok "knowledge volume present"; else no "knowledge volume present"; fi
  fi
else
  sk "container running"        "run on the VM"
  sk "liveliness 200"           "run on the VM"
  sk "state volume writable"    "run on the VM"
  sk "knowledge volume present" "run on the VM"
fi

if [ -f /var/log/agent-image-build.log ]; then
  if grep -qE 'BUILT (keel|castor|atlas):' /var/log/agent-image-build.log; then ok "image build marker present"; else no "image build marker missing"; fi
else
  sk "image build marker" "run on the VM"
fi

echo "== $pass passed, $fail failed, $skip skipped =="
[ "$fail" -eq 0 ]
