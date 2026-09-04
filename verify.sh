#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

fail() {
  echo "FAIL: $1"
  tail -40 "$LOG"
  exit 1
}

(cd "$ROOT" && cargo test --workspace) >"$LOG" 2>&1 || fail cargo
echo "cargo: $(grep -c '^test result: ok' "$LOG") suites ok"

(cd "$ROOT" && cargo clippy --workspace --all-targets -- -D warnings) >"$LOG" 2>&1 || fail clippy
echo "clippy: ok"

(cd "$ROOT" && cargo fmt --all -- --check) >"$LOG" 2>&1 || fail fmt
echo "fmt: ok"

(cd "$ROOT/web" && npx biome ci .) >"$LOG" 2>&1 || fail biome
echo "biome: ok"

(cd "$ROOT" && cargo deny check) >"$LOG" 2>&1 || fail deny
echo "deny: ok"

(cd "$ROOT/web" && npm audit --audit-level=high) >"$LOG" 2>&1 || fail audit
echo "audit: ok"

(cd "$ROOT/web" && npx tsc --noEmit) >"$LOG" 2>&1 || fail tsc
echo "tsc: ok"

(cd "$ROOT/web" && node tools/feed.js && node tools/pages.js) >"$LOG" 2>&1 || fail pages
echo "pages: $(grep -o 'colors ([^)]*)' "$LOG"), $(grep -o 'changelog ([^)]*)' "$LOG"), $(grep -o 'faq ([^)]*)' "$LOG")"

(cd "$ROOT/web" && node tools/e2e.js) >"$LOG" 2>&1 || fail e2e
echo "e2e: $(grep -c '^ok ' "$LOG") checks ok"

(cd "$ROOT/web" && node tools/mobile-survey.js --only phone-390 --assert --max-phone-height 25000 --out .shots/survey) >"$LOG" 2>&1 || fail mobile
echo "mobile: $(grep -o 'height=[0-9]*px' "$LOG") at 390"

(cd "$ROOT/web" && npm run build) >"$LOG" 2>&1 || fail build
echo "build: $(grep -o 'dist/sw\.js[^│]*│[^│]*' "$LOG" | head -1 | tr -s ' ') and $(grep -c '^dist/' "$LOG") files"

echo PASS
