#!/usr/bin/env bash
# Functional smoke test for one agent. Run ON the VM (over SSH) for the full set,
# or pass a reachable webchat URL to run the HTTP check from anywhere.
# Usage:  scripts/smoke-test.sh [webchatUrl]     (default http://127.0.0.1:8443)
set -uo pipefail
URL="${1:-http://127.0.0.1:8443}"
pass=0; fail=0; skip=0
ok(){ echo "  PASS  $1"; pass=$((pass+1)); }
no(){ echo "  FAIL  $1"; fail=$((fail+1)); }
sk(){ echo "  SKIP  $1 ($2)"; skip=$((skip+1)); }

echo "== smoke test: $URL =="

# 1) Webchat answers HTTP (works remotely through the tunnel or locally on the VM)
if curl -fsS --max-time 10 "$URL" -o /dev/null 2>/dev/null; then ok "webchat responds"; else no "webchat responds"; fi

# 2-5) Container-level checks require docker on this host (i.e. run on the VM)
if command -v docker >/dev/null 2>&1; then
  C=keel-webchat
  if sudo docker inspect -f '{{.State.Status}}' "$C" 2>/dev/null | grep -q running; then ok "container running"; else no "container running"; fi
  H="$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$C" 2>/dev/null || echo none)"
  [ "$H" = healthy ] && ok "container healthcheck healthy" || no "container healthcheck healthy (got: $H)"
  if sudo docker exec "$C" sh -c 'touch /app/state/.smoke && rm -f /app/state/.smoke' 2>/dev/null; then ok "state volume writable"; else no "state volume writable"; fi
  if sudo docker exec "$C" sh -c 'test -d /app/knowledge' 2>/dev/null; then ok "knowledge volume present"; else no "knowledge volume present"; fi
else
  sk "container running" "run on the VM"
  sk "container healthcheck" "run on the VM"
  sk "state volume writable" "run on the VM"
  sk "knowledge volume present" "run on the VM"
fi

echo "== $pass passed, $fail failed, $skip skipped =="
[ "$fail" -eq 0 ]
