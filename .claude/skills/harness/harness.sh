#!/usr/bin/env sh
# Top-level harness driver: sequences the existing phase scripts and owns the
# integration-branch git transitions that no single phase script covers. It
# REIMPLEMENTS NOTHING — routing/pricing/trace/worktree logic all live in the
# sibling skills (route-cost, eval-gate, parallel-build); this only orders calls.
#
# Two roots: sibling scripts resolve from THIS script's dir; git operations act
# on the target repo (cwd), exactly like wt.sh. Base branch defaults to `main`;
# set HARNESS_BASE to target a throwaway base for smoke tests (never real main).
#
# Usage:
#   harness.sh budget <plan.jsonl>   Gate A: price the routed batch (exit 1 if over ceiling)
#   harness.sh wt-new <slug>         create feat/<slug> worktree off the base
#   harness.sh integ-start           create the integration branch off the base
#   harness.sh integ-merge <slug>    merge feat/<slug> into integration (--no-ff)
#   harness.sh trace <session>       Gate D L2: check .claude/traces/<session>.jsonl
#   harness.sh promote               guarded fast-forward of base to integration (run only after the human go)
#   harness.sh clean                 remove merged worktrees + delete integration
set -eu

# --- resolve this script's dir (follow a one-level symlink so siblings resolve) ---
self=$0
case $self in */*) ;; *) self=$(command -v "$self") ;; esac
[ -L "$self" ] && self=$(readlink -f "$self")
skills=$(cd "$(dirname "$self")/.." && pwd -P)
WT="$skills/parallel-build/wt.sh"
BUDGET="$skills/route-cost/budget.py"
TRACE="$skills/eval-gate/trace-check.py"

BASE=${HARNESS_BASE:-main}

die() { echo "harness: $*" >&2; exit 1; }
on_branch() { [ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" = "$1" ]; }
tree_clean() { git diff --quiet && git diff --cached --quiet; }

cmd=${1:-}
case "$cmd" in
  budget)
    [ -n "${2:-}" ] || die "budget needs a <plan.jsonl>"
    python3 "$BUDGET" "$2"            # propagates exit 1 over ceiling (Gate A)
    ;;
  wt-new)
    [ -n "${2:-}" ] || die "wt-new needs a <slug>"
    sh "$WT" new "$2" "$BASE"         # echoes the worktree path on stdout
    ;;
  integ-start)
    git show-ref --verify --quiet refs/heads/integration && die "integration already exists — clean first"
    git checkout -b integration "$BASE"
    ;;
  integ-merge)
    [ -n "${2:-}" ] || die "integ-merge needs a <slug>"
    on_branch integration || die "not on integration (run integ-start first)"
    git merge --no-ff "feat/$2"       # stops on conflict for deliberate resolution (Gate C)
    ;;
  trace)
    [ -n "${2:-}" ] || die "trace needs a <session> id"
    f=".claude/traces/$2.jsonl"
    [ -f "$f" ] || die "no trace at $f (is the eval-gate PostToolUse hook registered?)"
    python3 "$TRACE" "$f"             # propagates exit 1 on LOOP/EXPLOSION/THRASH (Gate D L2)
    ;;
  promote)
    on_branch integration || die "promote must run on integration"
    tree_clean || die "integration tree is dirty — commit or stash first"
    git merge-base --is-ancestor "$BASE" integration || die "$BASE is not an ancestor of integration — not fast-forwardable"
    git checkout "$BASE"
    git merge --ff-only integration
    echo "promoted integration -> $BASE (fast-forward)"
    ;;
  clean)
    sh "$WT" clean "$BASE"
    git branch -d integration 2>/dev/null && echo "deleted integration" || true
    ;;
  *)
    echo "usage: harness.sh {budget <plan.jsonl> | wt-new <slug> | integ-start | integ-merge <slug> | trace <session> | promote | clean}" >&2
    exit 2
    ;;
esac
