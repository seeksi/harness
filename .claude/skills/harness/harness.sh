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
# EVENT CONTRACT (consumed by web/lib/daemon/harness-bridge.ts parseHarnessLine):
# STDOUT is a stream of line-delimited JSON events ONLY — one compact object per
# line, each with a "type" in {phase,subtask,gate,agentFire,trace,budget,approval}.
# All human/sibling output goes to STDERR so the stdout channel stays pure JSON.
# parseHarnessLine drops anything it doesn't recognize, so accidental stdout noise
# is non-fatal, but keep it on stderr by convention.
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

# --- JSON event emitters (stdout = the machine contract). Enum fields (status,
# severity, kind, phase number) are fixed literals from this script. Dynamic string
# fields (ids, summaries) are run through jesc so a stray quote/backslash can never
# break the line or inject an event — even though slugs are already regex-validated
# upstream, the emitter is the shell→JSON trust boundary, so escape there too. ---
now() { date +%s; }
emit() { printf '%s\n' "$1"; }
# Escape a string for embedding inside a JSON double-quoted value (backslash first).
jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

emit_phase() { # <phaseId 1-6> <status>
  emit "{\"type\":\"phase\",\"phase\":$1,\"status\":\"$2\"}"
}
emit_subtask() { # <id> <status> [phaseId]
  _sid=$(jesc "$1")
  if [ -n "${3:-}" ]; then
    emit "{\"type\":\"subtask\",\"id\":\"$_sid\",\"status\":\"$2\",\"phase\":$3}"
  else
    emit "{\"type\":\"subtask\",\"id\":\"$_sid\",\"status\":\"$2\"}"
  fi
}
emit_gate() { # <id A-D> <status> <severity> <summary> [subtaskId] [traceReady=true]
  _g="{\"type\":\"gate\",\"id\":\"$1\",\"status\":\"$2\",\"severity\":\"$3\",\"summary\":\"$(jesc "$4")\""
  [ -n "${5:-}" ] && _g="$_g,\"subtaskId\":\"$(jesc "$5")\""
  [ "${6:-}" = "true" ] && _g="$_g,\"traceReady\":true"
  emit "$_g}"
}
emit_agentfire() { # <subtaskId> <kind> <severity>
  _t=$(now); _aid=$(jesc "$1")
  emit "{\"type\":\"agentFire\",\"id\":\"$_aid-$2-$_t\",\"subtaskId\":\"$_aid\",\"kind\":\"$2\",\"severity\":\"$3\",\"firedAt\":$_t}"
}

cmd=${1:-}
case "$cmd" in
  budget)
    [ -n "${2:-}" ] || die "budget needs a <plan.jsonl>"
    emit_phase 3 active
    if python3 "$BUDGET" "$2" >&2; then   # Gate A: human/pricing output → stderr
      emit_gate A clear info "budget within ceiling"
      emit_phase 3 done
    else
      rc=$?
      emit_gate A raised high "budget over ceiling"
      emit_phase 3 blocked
      exit "$rc"                          # propagate the over-ceiling failure
    fi
    ;;
  wt-new)
    [ -n "${2:-}" ] || die "wt-new needs a <slug>"
    emit_phase 2 active
    if sh "$WT" new "$2" "$BASE" >&2; then   # echoes the worktree path → stderr
      emit_subtask "$2" building 2
    else
      rc=$?
      emit_subtask "$2" blocked 2
      emit_phase 2 blocked
      exit "$rc"
    fi
    ;;
  integ-start)
    git show-ref --verify --quiet refs/heads/integration && die "integration already exists — clean first"
    git checkout -b integration "$BASE" >&2
    emit_phase 5 active
    ;;
  integ-merge)
    [ -n "${2:-}" ] || die "integ-merge needs a <slug>"
    on_branch integration || die "not on integration (run integ-start first)"
    emit_phase 5 active
    if git merge --no-ff "feat/$2" >&2; then
      emit_subtask "$2" merged
      emit_agentfire "$2" merge low
      emit_gate C clear info "merged feat/$2" "$2"
    else
      rc=$?
      emit_gate C raised high "merge conflict in feat/$2" "$2"  # Gate C: integration red
      emit_subtask "$2" blocked
      emit_phase 5 blocked
      exit "$rc"
    fi
    ;;
  trace)
    [ -n "${2:-}" ] || die "trace needs a <session> id"
    f=".claude/traces/$2.jsonl"
    [ -f "$f" ] || die "no trace at $f (is the eval-gate PostToolUse hook registered?)"
    emit_phase 4 active
    if python3 "$TRACE" "$f" >&2; then    # Gate D L2: check output → stderr
      emit_gate D clear info "trajectory healthy"
      emit_phase 4 done
    else
      rc=$?
      emit_gate D raised high "trajectory anomaly" "" true
      emit_phase 4 blocked
      exit "$rc"                          # propagate LOOP/EXPLOSION/THRASH
    fi
    ;;
  promote)
    on_branch integration || die "promote must run on integration"
    tree_clean || die "integration tree is dirty — commit or stash first"
    git merge-base --is-ancestor "$BASE" integration || die "$BASE is not an ancestor of integration — not fast-forwardable"
    # NB: the approval event (promote-to-main awaiting→approved) is owned by the
    # control plane (the operator's human go), NOT this script — harness.sh must not
    # forge it. By the time promote runs, that gate has already passed upstream.
    emit_phase 6 active
    if git checkout "$BASE" >&2 && git merge --ff-only integration >&2; then
      emit_agentfire promote promote low
      emit_phase 6 done
      echo "promoted integration -> $BASE (fast-forward)" >&2
    else
      rc=$?
      emit_phase 6 blocked
      exit "$rc"
    fi
    ;;
  clean)
    sh "$WT" clean "$BASE" >&2
    git branch -d integration 2>/dev/null && echo "deleted integration" >&2 || true
    ;;
  *)
    echo "usage: harness.sh {budget <plan.jsonl> | wt-new <slug> | integ-start | integ-merge <slug> | trace <session> | promote | clean}" >&2
    exit 2
    ;;
esac
