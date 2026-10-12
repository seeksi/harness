#!/usr/bin/env bash
# harness.sh review-record: CLI twin of the integ-merge review artifact. Plain bash, no bats.
set -euo pipefail
PASS_COUNT=0
FAIL_COUNT=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$HERE/../.claude/skills/harness/harness.sh"
TMP_BASE=$(mktemp -d)
cleanup() { [ -z "$TMP_BASE" ] || rm -rf "$TMP_BASE"; }
trap cleanup EXIT

assert() {
  local condition="$1" message="$2"
  set +e; eval "$condition"; local result=$?; set -e
  if [ $result -eq 0 ]; then echo "PASS: $message"; PASS_COUNT=$((PASS_COUNT + 1))
  else echo "FAIL: $message (condition: $condition)"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}

mkrepo() {
  local d="$1"
  git init -q -b main "$d"
  git -C "$d" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  git -C "$d" switch -q -c feat/x
  echo x > "$d/x.txt"; git -C "$d" add x.txt; git -C "$d" -c user.name=t -c user.email=t@t commit -qm "lane x"
  git -C "$d" switch -q main
}
REVIEWS="$TMP_BASE/reviews"
run_rr() { # <repo> args... -> OUT, RC
  local d="$1"; shift
  set +e
  OUT=$(cd "$d" && env HARNESS_REVIEWS_DIR="$REVIEWS" HARNESS_BASE=main sh "$HARNESS" review-record "$@" 2>&1); RC=$?
  set -e
}
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

R="$TMP_BASE/r1"; mkrepo "$R"
SHA=$(git -C "$R" rev-parse feat/x)

# 1. PASS
run_rr "$R" PASS feat/x
assert '[ $RC -eq 0 ]' "PASS: exits 0"
assert '[ -f "$REVIEWS/$SHA.json" ]' "PASS: file written"
assert '[ "$(field "$REVIEWS/$SHA.json" head)" = "$SHA" ]' "PASS: head is full sha"
assert '[ "$(field "$REVIEWS/$SHA.json" verdict)" = PASS ]' "PASS: verdict"
assert '[ "$(field "$REVIEWS/$SHA.json" reviewer)" = harness-cli ]' "PASS: reviewer"
assert '[ "$(field "$REVIEWS/$SHA.json" ref)" = feat/x ]' "PASS: ref"
assert 'field "$REVIEWS/$SHA.json" at | grep -Eq "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$"' "PASS: ISO-8601 UTC at"
assert 'echo "$OUT" | grep -q "review-record: PASS for feat/x ($(printf %.12s "$SHA"))"' "PASS: stderr line"

# 2. BLOCK
rm -f "$REVIEWS"/*.json
run_rr "$R" BLOCK feat/x
assert '[ $RC -eq 0 ] && [ "$(field "$REVIEWS/$SHA.json" verdict)" = BLOCK ]' "BLOCK: writes BLOCK"

# 3. bad verdict
rm -rf "$REVIEWS"
run_rr "$R" pass feat/x
assert '[ $RC -eq 1 ] && [ ! -e "$REVIEWS" ]' "bad verdict: exit 1, nothing written"

# 4. unresolvable ref
run_rr "$R" PASS no-such-ref
assert '[ $RC -eq 1 ] && [ ! -e "$REVIEWS" ]' "bad ref: exit 1, nothing written"

# 5. default ref is HEAD
HSHA=$(git -C "$R" rev-parse HEAD)
run_rr "$R" PASS
assert '[ $RC -eq 0 ] && [ "$(field "$REVIEWS/$HSHA.json" ref)" = HEAD ]' "default ref: HEAD"

# 6. recorded PASS lets integ-merge merge
R2="$TMP_BASE/r2"; mkrepo "$R2"; git -C "$R2" switch -q -c integration
rm -rf "$REVIEWS"
run_rr "$R2" PASS feat/x
set +e
OUT=$(cd "$R2" && env HARNESS_REVIEWS_DIR="$REVIEWS" HARNESS_BASE=main sh "$HARNESS" integ-merge x 2>&1); RC=$?
set -e
assert '[ $RC -eq 0 ]' "integ-merge: exits 0 after review-record PASS"
assert 'git -C "$R2" log --oneline integration | grep -q "Merge branch .feat/x"' "integ-merge: feat/x merged"

echo "=== Summary ==="
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
