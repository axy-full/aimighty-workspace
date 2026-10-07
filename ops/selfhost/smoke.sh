#!/usr/bin/env bash
# Read-only smoke test for a Particl deployment. curl only.
# Usage: ops/selfhost/smoke.sh https://test.example.com
# It never signs in and never POSTs. Every request is a GET.
# Exit 0 = every check passed, 1 = at least one failed, 2 = bad usage.
set -u
BASE="${1:-}"
if [ -z "$BASE" ]; then echo "usage: $0 <base-url>" >&2; exit 2; fi
BASE="${BASE%/}"
case "$BASE" in http://*|https://*) ;; *) echo "base url must start with http:// or https://" >&2; exit 2;; esac

FAILS=0; FIVEXX=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

pass() { printf '  PASS  %-34s %s\n' "$1" "$2"; }
fail() { printf '  FAIL  %-34s %s\n' "$1" "$2"; FAILS=$((FAILS+1)); }

# get <name> <path> [extra curl args] -> sets CODE, SECS; body in $TMP/body, headers in $TMP/hdr
get() {
  local path="$2"; shift 2
  local out
  out="$(curl -sS -m 20 -o "$TMP/body" -D "$TMP/hdr" -w '%{http_code} %{time_total}' "$@" "$BASE$path" 2>"$TMP/err")" || out="000 0"
  CODE="${out%% *}"; SECS="${out##* }"
  case "$CODE" in 5??) FIVEXX=$((FIVEXX+1));; esac
}

echo "Particl smoke test: $BASE"

# 1. Home answers 200 (a signed-out visitor sees the public site; redirects are followed, at most 3)
get home / -L --max-redirs 3
[ "$CODE" = 200 ] && pass "home /" "200 in ${SECS}s" || fail "home /" "got $CODE (loop or error), ${SECS}s"

# 2. Sign-in page
get signin /login -L --max-redirs 3
[ "$CODE" = 200 ] && pass "sign-in page /login" "200 in ${SECS}s" || fail "sign-in page /login" "got $CODE"
cp "$TMP/body" "$TMP/login.html"

# 3. Health: 200 and "ok":true. The public answer carries no secrets.
get health /api/health
if [ "$CODE" = 200 ] && grep -q '"ok":true' "$TMP/body"; then pass "health /api/health" "ok in ${SECS}s"
else fail "health /api/health" "got $CODE: $(head -c 200 "$TMP/body")"; fi

# 4. A static asset from the page itself
ASSET="$(grep -o '/_next/static/[^"'"'"' ]*\.js' "$TMP/login.html" | head -1)"
if [ -z "$ASSET" ]; then fail "static asset" "no /_next/static script found on /login"
else
  get asset "$ASSET"
  CC="$(grep -i '^cache-control:' "$TMP/hdr" | head -1 | tr -d '\r')"
  [ "$CODE" = 200 ] && pass "static asset" "200 in ${SECS}s ${CC:-no cache-control}" || fail "static asset" "$ASSET got $CODE"
fi

# 5. A worker file the image must carry (copied by the postinstall into public/vendor)
get vendor /vendor/tesseract-7.0.0/worker.min.js
[ "$CODE" = 200 ] && pass "vendor worker file" "200 in ${SECS}s" || fail "vendor worker file" "got $CODE (public/vendor missing from the image?)"

# 6. Signed-out API routes answer 401
for r in /api/me /api/projects; do
  get api401 "$r"
  [ "$CODE" = 401 ] && pass "signed-out $r" "401 in ${SECS}s" || fail "signed-out $r" "expected 401, got $CODE"
done

# 7. The cron route refuses a request without the secret (proves CRON_SECRET is set on this server)
get cron /api/cron/sync
[ "$CODE" = 401 ] && pass "cron without secret" "401 in ${SECS}s" || fail "cron without secret" "expected 401, got $CODE"

# 8. Security headers present
get headers /login
grep -qi '^x-frame-options: DENY' "$TMP/hdr" && grep -qi '^content-security-policy:' "$TMP/hdr" \
  && pass "security headers" "frame + CSP present" || fail "security headers" "missing"

# 9. No 5xx anywhere above
[ "$FIVEXX" -eq 0 ] && pass "no 5xx" "0 responses >= 500" || fail "no 5xx" "$FIVEXX response(s) >= 500"

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: all checks passed"; exit 0; fi
echo "RESULT: $FAILS check(s) failed"; exit 1
