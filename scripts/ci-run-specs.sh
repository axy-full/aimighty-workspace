#!/usr/bin/env bash
# Runs named browser specs on fresh dev servers (docs/ci.md): the slim per-PR set and the five-minute test.
#
#   scripts/ci-run-specs.sh <workbench|customer> <grep|-> <spec file>...
#   scripts/ci-run-specs.sh five-minute
#
# The same server handling as verify.yml's full browser job: every server answers every route before any spec runs
# (scripts/warm-dev-routes.mjs), and a server never lives through more than CHUNK spec files, so none grows the way a
# long-lived Turbopack dev server does. A failed chunk fails the run, but only after the later chunks have run.
# Environment: the same as the full job (ENGINE_MOCK, PW_BASE_URL, PLATFORM_DATABASE_URL, ...), set by the workflow.
set -u
SUITE=${1:?suite}
GREP=${2:--}
shift 2 2>/dev/null || shift $#
CHUNK=${CHUNK:-6}
PORT=4551
failed=()

start_server() {
  started=$SECONDS
  NODE_OPTIONS="--import $PWD/scripts/ci-keep-alive.mjs" setsid npm run dev -- -p $PORT > "dev-ci-$label.log" 2>&1 &
  server=$!
  for _ in {1..90}; do
    if curl --fail --silent "http://localhost:$PORT/api/health" >/dev/null; then
      echo "[slim] $label dev server ready in $((SECONDS - started)) s"
      return 0
    fi
    kill -0 "$server" 2>/dev/null || break
    sleep 2
  done
  cat "dev-ci-$label.log"
  return 1
}
stop_server() {
  kill -TERM -- "-$server" 2>/dev/null || true
  for attempt in {1..30}; do
    kill -0 -- "-$server" 2>/dev/null || break
    [ "$attempt" -eq 20 ] && kill -KILL -- "-$server" 2>/dev/null || true
    sleep 1
  done
  wait "$server" 2>/dev/null || true
}
run_chunk() {
  label=$1; shift
  ready=
  for try in 1 2; do
    if start_server && node scripts/warm-dev-routes.mjs "http://localhost:$PORT"; then ready=1; break; fi
    stop_server
    mv .next "$RUNNER_TEMP/next-$label-$try" 2>/dev/null || true
  done
  if [ -z "$ready" ]; then failed+=("$label (dev server not ready)"); return; fi
  "$@" || failed+=("$label")
  stop_server
}

if [ "$SUITE" = "five-minute" ]; then
  run_chunk five-minute npx playwright test --config=playwright.five-minute.config.ts --output=ci-results/five-minute
else
  [ "$#" -gt 0 ] || { echo "::error::No spec files given"; exit 1; }
  for spec in "$@"; do [ -f "$spec" ] || { echo "::error::$spec does not exist"; exit 1; }; done
  n=0
  while [ "$#" -gt 0 ]; do
    chunk=("${@:1:$CHUNK}")
    shift "$(( $# < CHUNK ? $# : CHUNK ))"
    n=$((n + 1))
    args=(npx playwright test --config="playwright.$SUITE.config.ts" --output="ci-results/$SUITE/slim-$n")
    [ "$GREP" != "-" ] && args+=(--grep "$GREP")
    run_chunk "$SUITE-$n" "${args[@]}" "${chunk[@]}"
  done
fi
if [ ${#failed[@]} -gt 0 ]; then
  echo "::error::Failed: ${failed[*]}"
  exit 1
fi
