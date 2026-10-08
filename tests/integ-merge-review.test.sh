#!/usr/bin/env bash
# harness.sh integ-merge: the cross-review artifact gate (Gate B, daemon path).
# Plain bash, no bats. Temp repo with main + feat/x + integration; artifacts under a temp
# HARNESS_REVIEWS_DIR. Runs the real harness.sh.
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

# A repo on `integration` with feat/x one commit ahead of main.
mkrepo() {
  local d="$1"
  git init -q -b main "$d"
  git -C "$d" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  git -C "$d" switch -q -c feat/x
  echo x > "$d/x.txt"; git -C "$d" add x.txt; git -C "$d" -c user.name=t -c user.email=t@t commit -qm "lane x"
  git -C "$d" switch -q main
  git -C "$d" switch -q -c integration
}
REVIEWS="$TMP_BASE/reviews"; mkdir -p "$REVIEWS"
record() { # <repo> <ref> <verdict> [head-override]
  local sha; sha=$(git -C "$1" rev-parse "$2")
  printf '{"verdict":"%s","head":"%s"}\n' "$3" "${4:-$sha}" > "$REVIEWS/$sha.json"
}
run_merge() { # <repo> [env...] -> stdout+stderr in OUT, exit in RC
  local d="$1"; shift
  set +e
  OUT=$(cd "$d" && env HARNESS_REVIEWS_DIR="$REVIEWS" HARNESS_BASE=main "$@" bash "$HARNESS" integ-merge x 2>&1); RC=$?
  set -e
}

# 1. No artifact → blocked, nothing merged.
R="$TMP_BASE/r1"; mkrepo "$R"; run_merge "$R"
assert '[ $RC -eq 1 ]' "no artifact: exits 1"
assert 'echo "$OUT" | grep -q "no cross-review PASS on record for feat/x.*/review-record PASS feat/x"' "no artifact: Gate B raised with the /review-record hint"
assert '[ "$(git -C "$R" rev-list --count main..integration)" -eq 0 ]' "no artifact: integration untouched"

# 2. BLOCK on record → still blocked.
record "$R" feat/x BLOCK; run_merge "$R"
assert '[ $RC -eq 1 ]' "BLOCK artifact: exits 1"

# 3. PASS for a different head → blocked.
record "$R" feat/x PASS "$(printf 'd%.0s' $(seq 40))"; run_merge "$R"
assert '[ $RC -eq 1 ] && echo "$OUT" | grep -q "no cross-review PASS"' "PASS with a mismatched head: blocked"

# 4. PASS for the lane head → merged.
record "$R" feat/x PASS; run_merge "$R"
assert '[ $RC -eq 0 ]' "PASS artifact: exits 0"
assert 'echo "$OUT" | grep -q "cross-review PASS on record for feat/x"' "PASS artifact: Gate B clear line"
assert 'git -C "$R" log --oneline integration | grep -q "Merge branch .feat/x"' "PASS artifact: feat/x merged into integration"

# 5. Lane moves after the PASS → blocked again.
R2="$TMP_BASE/r2"; mkrepo "$R2"; record "$R2" feat/x PASS
git -C "$R2" switch -q feat/x; echo y > "$R2/y.txt"; git -C "$R2" add y.txt; git -C "$R2" -c user.name=t -c user.email=t@t commit -qm "more"; git -C "$R2" switch -q integration
run_merge "$R2"
assert '[ $RC -eq 1 ]' "stale PASS (lane moved): blocked"

# 6. HARNESS_REVIEW_GATE=skip merges and says so.
run_merge "$R2" HARNESS_REVIEW_GATE=skip
assert '[ $RC -eq 0 ]' "skip: exits 0"
assert 'echo "$OUT" | grep -q "review gate SKIPPED"' "skip: gate B warn line names the skip"

echo "=== Summary ==="
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
