#!/bin/bash
# usage: serve.sh <logname> [CREDIT_USD]  — starts next dev on :4620 in its own process group, prints the PGID
cd "$(dirname "$0")/../../.."
D="$PWD/.data/conv-rehearsal"; mkdir -p "$D"
set -m
if [ -n "$2" ]; then export CREDIT_USD="$2"; else unset CREDIT_USD; fi
ENGINE_MOCK=1 APP_ORIGIN=http://localhost:4620 PLATFORM_DATABASE_URL="file:$D/platform.db" TURSO_DATABASE_URL="file:$D/legacy.db" \
SUPER_ADMIN_EMAIL=platform-owner@example.test CI_DEV_SOURCE_MAPS=off \
  nohup npm run dev -- -p 4620 > "$D/$1.log" 2>&1 &
echo $! > "$D/server.pid"
echo "started pgid $!"
