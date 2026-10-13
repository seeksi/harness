#!/usr/bin/env bash
# harness.sh wt-verify: TDD evidence is read from the lane worktree's .harness/tdd/ and is
# never part of the lane's commit (wt-commit leaves it unstaged). Plain bash, no bats.
set -euo pipefail
PASS_COUNT=0; FAIL_COUNT=0
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
G="git -c user.name=t -c user.email=t@t"
# Repo + registered lane worktree <repo>.worktrees/<slug> on feat/<slug>, agent edits uncommitted.
mklane() { # <dir> <slug>
  local d="$1" s="$2"
  git init -q -b main "$d"; $G -C "$d" commit -q --allow-empty -m init
  git -C "$d" worktree add -q -b "feat/$s" "$d.worktrees/$s" main
  mkdir -p "$d.worktrees/$s/tests" "$d.worktrees/$s/.harness/tdd"
  echo 'exit 0' > "$d.worktrees/$s/tests/a.test.sh"
}
evidence() { # <wt> <slug>
  printf 'exit=1\nfail\n' > "$1/.harness/tdd/$2.red.log"
  printf 'exit=0\nok\n' > "$1/.harness/tdd/$2.green.log"
}
run() { # <repo> <sub> <slug>
  set +e; OUT=$(cd "$1" && env HARNESS_BASE=main sh "$HARNESS" "$2" "$3" 2>&1); RC=$?; set -e
}

# 1. Full path: wt-commit then wt-verify, evidence present → clear, evidence NOT in the commit.
R="$TMP_BASE/r1"; mklane "$R" x; evidence "$R.worktrees/x" x
run "$R" wt-commit x; assert '[ $RC -eq 0 ]' "wt-commit succeeds"
assert '! git -C "$R" ls-tree -r --name-only feat/x | grep -q "^.harness/"' "wt-commit did not commit .harness/tdd"
assert 'git -C "$R" ls-tree -r --name-only feat/x | grep -q "^tests/a.test.sh$"' "wt-commit committed the test file"
run "$R" wt-verify x; assert '[ $RC -eq 0 ]' "wt-verify clear with untracked evidence"
assert 'echo "$OUT" | grep -q "TDD evidence present"' "wt-verify reports evidence present"

# 2. No evidence files → raised.
R="$TMP_BASE/r2"; mklane "$R" y
run "$R" wt-commit y; run "$R" wt-verify y
assert '[ $RC -eq 1 ]' "wt-verify blocks without evidence"
assert 'echo "$OUT" | grep -q "no failing RED"' "reason names the missing red log"

# 3. .skip file → clear with warn.
R="$TMP_BASE/r3"; mklane "$R" z; echo "docs-only" > "$R.worktrees/z/.harness/tdd/z.skip"
run "$R" wt-commit z; run "$R" wt-verify z
assert '[ $RC -eq 0 ]' "wt-verify clear with .skip"
assert 'echo "$OUT" | grep -q "TDD evidence skipped: docs-only"' "skip reason surfaced"

# 4. Other untracked junk still trips the clean check.
R="$TMP_BASE/r4"; mklane "$R" w; evidence "$R.worktrees/w" w
run "$R" wt-commit w; echo junk > "$R.worktrees/w/stray.txt"
run "$R" wt-verify w
assert '[ $RC -eq 1 ]' "stray untracked file still blocks"

echo; echo "passed: $PASS_COUNT failed: $FAIL_COUNT"; [ "$FAIL_COUNT" -eq 0 ]
