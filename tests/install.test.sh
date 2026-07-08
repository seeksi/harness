#!/usr/bin/env bash
# Test suite for install.sh
# Plain bash, no bats. Creates temp fixtures, runs the real install.sh, verifies behavior.
set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0

# One suite-wide temp root; every scenario gets a subdir under it so cleanup is total
# (reassigning a per-test root would leak all but the last tree).
TMP_BASE=$(mktemp -d)
cleanup() { [ -z "$TMP_BASE" ] || rm -rf "$TMP_BASE"; }
trap cleanup EXIT

# Assert a condition; never aborts the suite (set -e is toggled off around the eval).
assert() {
  local condition="$1"
  local message="$2"
  set +e
  eval "$condition"
  local result=$?
  set -e
  if [ $result -eq 0 ]; then
    echo "PASS: $message"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: $message (condition: $condition)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# Find the real install.sh (repo root is one level up from tests/).
REAL_INSTALL_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install.sh"
if [ ! -f "$REAL_INSTALL_SH" ]; then
  echo "FAIL: Could not find install.sh at $REAL_INSTALL_SH"
  exit 1
fi

# Fake repo with two skills + an executable bin/gantry, and the REAL install.sh copied in
# so its BASH_SOURCE-derived HERE resolves to the fake repo (SRC/BIN_SRC point at fixtures).
setup_fake_repo() {
  local repo_dir="$1"
  mkdir -p "$repo_dir/.claude/skills/skillA" "$repo_dir/.claude/skills/skillB" "$repo_dir/bin"
  touch "$repo_dir/bin/gantry"
  chmod +x "$repo_dir/bin/gantry"
  cp "$REAL_INSTALL_SH" "$repo_dir/install.sh"
  chmod +x "$repo_dir/install.sh"
}

setup_fake_home() {
  mkdir -p "$1/.local/bin" "$1/.claude/skills"
}

# Run install.sh from $1 (repo path, possibly a symlink) with fake HOME=$2 and extra args $3+.
# Echoes the real exit code so callers can ASSERT it (no `|| true` that would hide a
# non-zero exit on a broken script).
run_install() {
  local run_from="$1" home_dir="$2"; shift 2
  local rc=0
  ( cd "$run_from" && HOME="$home_dir" bash install.sh "$@" >/dev/null 2>&1 ) || rc=$?
  echo "$rc"
}

# Scenario A: fresh install, then two idempotent re-runs, then uninstall (needs a prior
# install to have something to remove). Shares one repo+home tree by design.
scenario_install_idempotent_uninstall() {
  local dir="$TMP_BASE/A"; mkdir -p "$dir"
  local repo_dir="$dir/repo" home_dir="$dir/home"
  setup_fake_repo "$repo_dir"
  setup_fake_home "$home_dir"

  # --- fresh install: exit 0 + correct symlinks ---
  local rc; rc=$(run_install "$repo_dir" "$home_dir")
  assert "[ '$rc' = '0' ]" "fresh install: exit 0"
  assert "[ -L '$home_dir/.local/bin/gantry' ]" "fresh install: gantry is a symlink"
  if [ -L "$home_dir/.local/bin/gantry" ]; then
    assert "[ \"\$(readlink -f '$home_dir/.local/bin/gantry')\" = \"\$(readlink -f '$repo_dir/bin/gantry')\" ]" \
      "fresh install: gantry symlink resolves to repo's bin/gantry"
  fi
  assert "[ -L '$home_dir/.claude/skills/skillA' ]" "fresh install: skillA is a symlink"
  assert "[ -L '$home_dir/.claude/skills/skillB' ]" "fresh install: skillB is a symlink"
  assert "[ \"\$(readlink -f '$home_dir/.claude/skills/skillA')\" = \"\$(readlink -f '$repo_dir/.claude/skills/skillA')\" ]" \
    "fresh install: skillA symlink resolves to repo's skills/skillA"

  local gantry_before; gantry_before=$(readlink "$home_dir/.local/bin/gantry")

  # --- idempotent x2: each re-run exits 0 and leaves the symlink identical ---
  rc=$(run_install "$repo_dir" "$home_dir")
  assert "[ '$rc' = '0' ]" "idempotent 1: exit 0"
  assert "[ -L '$home_dir/.local/bin/gantry' ]" "idempotent 1: gantry symlink still exists"
  assert "[ \"\$(readlink '$home_dir/.local/bin/gantry')\" = '$gantry_before' ]" "idempotent 1: gantry symlink unchanged"

  rc=$(run_install "$repo_dir" "$home_dir")
  assert "[ '$rc' = '0' ]" "idempotent 2: exit 0"
  assert "[ -L '$home_dir/.local/bin/gantry' ]" "idempotent 2: gantry symlink still exists"
  assert "[ -L '$home_dir/.claude/skills/skillA' ]" "idempotent 2: skillA symlink still exists"

  # --- uninstall: removes only its own symlinks; a foreign symlink survives ---
  local foreign_target="$dir/foreign_location"
  mkdir -p "$foreign_target"
  ln -s "$foreign_target" "$home_dir/.claude/skills/foreign"

  rc=$(run_install "$repo_dir" "$home_dir" --uninstall)
  assert "[ '$rc' = '0' ]" "uninstall: exit 0"
  # Own symlinks gone: assert not-present AND not-a-symlink (a bare -e is true for a
  # DANGLING symlink, so a broken uninstall that left a dead link would pass -e alone).
  assert "[ ! -e '$home_dir/.local/bin/gantry' ] && [ ! -L '$home_dir/.local/bin/gantry' ]" "uninstall: gantry symlink removed"
  assert "[ ! -e '$home_dir/.claude/skills/skillA' ] && [ ! -L '$home_dir/.claude/skills/skillA' ]" "uninstall: skillA symlink removed"
  assert "[ ! -e '$home_dir/.claude/skills/skillB' ] && [ ! -L '$home_dir/.claude/skills/skillB' ]" "uninstall: skillB symlink removed"
  # Foreign symlink untouched.
  assert "[ -L '$home_dir/.claude/skills/foreign' ]" "uninstall: foreign symlink survives"
  assert "[ \"\$(readlink '$home_dir/.claude/skills/foreign')\" = '$foreign_target' ]" "uninstall: foreign symlink target unchanged"
}

# Scenario B: install.sh must REFUSE to clobber a foreign regular file at the gantry dest,
# exiting non-zero and leaving the file byte-for-byte intact.
scenario_refuse_clobber() {
  local dir="$TMP_BASE/B"; mkdir -p "$dir"
  local repo_dir="$dir/repo" home_dir="$dir/home"
  setup_fake_repo "$repo_dir"
  setup_fake_home "$home_dir"

  echo "foreign file content" > "$home_dir/.local/bin/gantry"

  local rc; rc=$(run_install "$repo_dir" "$home_dir")
  assert "[ '$rc' != '0' ]" "refuse clobber: install.sh exits non-zero"
  assert "[ -f '$home_dir/.local/bin/gantry' ] && [ ! -L '$home_dir/.local/bin/gantry' ]" "refuse clobber: foreign file remains regular file"
  assert "grep -q 'foreign file content' '$home_dir/.local/bin/gantry'" "refuse clobber: foreign file contents unchanged"
}

# Scenario C: canonicalization under a path-spelling MISMATCH. Install through a SYMLINK to
# the repo (so the created links carry the symlinked spelling), then uninstall through the
# REAL repo path (a different spelling of the same tree). install.sh only recognizes its own
# links to remove because it compares `readlink -f` (fully canonical) on both sides — a raw
# `readlink` implementation would see "symlink_repo/bin/gantry" != "real_repo/bin/gantry" and
# leave the links behind. This is the direction canonicalization actually handles: uninstall's
# $SRC is already the canonical real path, and readlink -f on each installed link resolves
# through the symlink back to it, so gantry AND both skill links are matched and removed.
scenario_symlinked_repo() {
  local dir="$TMP_BASE/C"; mkdir -p "$dir"
  local real_repo="$dir/real_repo" symlink_repo="$dir/symlink_repo" home_dir="$dir/home"
  setup_fake_repo "$real_repo"
  setup_fake_home "$home_dir"
  ln -s "$real_repo" "$symlink_repo"

  # Install via the SYMLINKED spelling.
  local rc; rc=$(run_install "$symlink_repo" "$home_dir")
  assert "[ '$rc' = '0' ]" "symlinked repo: install exit 0"
  assert "[ -L '$home_dir/.local/bin/gantry' ]" "symlinked repo: gantry is a symlink"
  assert "[ \"\$(readlink -f '$home_dir/.local/bin/gantry')\" = \"\$(readlink -f '$real_repo/bin/gantry')\" ]" \
    "symlinked repo: gantry resolves to real bin/gantry via canonicalization"
  assert "[ -L '$home_dir/.claude/skills/skillA' ]" "symlinked repo: skillA installed"

  # Uninstall via the REAL spelling — the mismatch that only canonical matching survives.
  rc=$(run_install "$real_repo" "$home_dir" --uninstall)
  assert "[ '$rc' = '0' ]" "symlinked repo: uninstall exit 0"
  assert "[ ! -e '$home_dir/.local/bin/gantry' ] && [ ! -L '$home_dir/.local/bin/gantry' ]" "symlinked repo: uninstall removes gantry symlink across spelling mismatch"
  assert "[ ! -e '$home_dir/.claude/skills/skillA' ] && [ ! -L '$home_dir/.claude/skills/skillA' ]" "symlinked repo: uninstall removes skillA across spelling mismatch"
  assert "[ ! -e '$home_dir/.claude/skills/skillB' ] && [ ! -L '$home_dir/.claude/skills/skillB' ]" "symlinked repo: uninstall removes skillB across spelling mismatch"
}

echo "=== install.sh test suite ==="
echo ""

scenario_install_idempotent_uninstall
scenario_refuse_clobber
scenario_symlinked_repo

echo ""
echo "=== Summary ==="
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"

[ $FAIL_COUNT -eq 0 ]
