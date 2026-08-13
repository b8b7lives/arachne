#!/usr/bin/env bash
# Full gate, one verdict. Detail prints only on failure.
# e2e needs the dev server up (npm run dev in web/, see README Testing).
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

(cd "$ROOT/web" && npx tsc --noEmit) >"$LOG" 2>&1 || fail tsc
echo "tsc: ok"

(cd "$ROOT/web" && node tools/e2e.js) >"$LOG" 2>&1 || fail e2e
echo "e2e: $(grep -c '^ok ' "$LOG") checks ok"

echo PASS
