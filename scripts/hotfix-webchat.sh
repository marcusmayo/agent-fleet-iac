#!/usr/bin/env bash
# hotfix-webchat.sh - copy the webchat server.js AND chat.html from the on-VM agent
# repo into the running container, restart, and verify. Run ON the agent VM.
#
# Copies BOTH files by design: a server-route change needs server.js, and copying
# only chat.html leaves the front end calling a route the container doesn't have
# (the "<!DOCTYPE ... is not valid JSON" failure). This makes that impossible.
#
# Auto-detects: sudo-vs-not for docker, the webchat dir (castor scaffold/webchat vs
# keel webchat/), and the *webchat container by name. Usage:  bash hotfix-webchat.sh
set -uo pipefail

# docker may need sudo on legacy instances (agentadmin not always in the docker group)
DK="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then DK="sudo docker"
  else echo "ABORT: cannot reach docker (with or without sudo)"; exit 1; fi
fi

# webchat source dir: castor keeps it under scaffold/, keel at repo root
if   [ -d "$HOME/agent/scaffold/webchat" ]; then SRC="$HOME/agent/scaffold/webchat"
elif [ -d "$HOME/agent/webchat" ];          then SRC="$HOME/agent/webchat"
else echo "ABORT: no webchat dir under ~/agent (scaffold/webchat or webchat)"; exit 1; fi

CTR="$($DK ps --format '{{.Names}}' | grep -i webchat | head -1)"
[ -n "$CTR" ] || { echo "ABORT: no running *webchat* container found"; exit 1; }
echo ">> source: $SRC   container: $CTR"

for f in server.js chat.html; do
  [ -f "$SRC/$f" ] || { echo "ABORT: $SRC/$f missing"; exit 1; }
  $DK cp "$SRC/$f" "$CTR:/app/webchat/$f"
  echo "   copied $f"
done

$DK restart "$CTR" >/dev/null
echo ">> restarted $CTR; waiting for liveliness..."

PORT=8443
code=""
for i in $(seq 1 30); do
  code=$($DK exec "$CTR" sh -c "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health/liveliness" 2>/dev/null)
  [ "$code" = "200" ] && { echo ">> webchat live"; break; }
  sleep 2
done
[ "$code" = "200" ] || { echo "WARN: liveliness not 200 (got '$code') - check: $DK logs $CTR"; exit 1; }

# 200/302/401 = a route exists; 404 = the old server.js is still running (server.js copy failed)
ccode=$($DK exec "$CTR" sh -c "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/color" 2>/dev/null)
if [ "$ccode" = "404" ]; then echo "WARN: /color returned 404 - server.js did not update"
else echo ">> both files live, /color route present (HTTP $ccode). Hotfix complete."; fi
