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
#   harness.sh wt-commit <slug>      stage+commit the lane worktree IF dirty (no-op stays uncommitted)
#   harness.sh wt-verify <slug>      Gate B: feat/<slug> committed + worktree clean (exit 1 if a no-op agent)
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
  wt-commit)
    # The harness (NOT the agent — it has no Bash) commits the lane after the agent edits.
    # The agent has Write/Edit INSIDE the worktree, so everything here is adversarial-input
    # hardened: the target worktree+branch are validated from the TRUSTED main repo before
    # any stage, and the commit pins identity/hooks/signing so it can't be steered or fail
    # on a bare prod host. Commit ONLY if the index differs from HEAD: a genuine no-op lane
    # stays uncommitted so Gate B (wt-verify) still RAISES on a do-nothing agent.
    # [#env leak] Drop ambient GIT_* that could redirect any git below to an agent- or
    # caller-chosen dir/config/index. Done FIRST, before any git op in this case. The
    # per-commit GIT_AUTHOR_*/COMMITTER_* are set inline later, not here.
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG \
      GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM 2>/dev/null || true
    slug=${2:-}
    [ -n "$slug" ] || die "wt-commit needs a <slug>"
    case "$slug" in *[!a-zA-Z0-9_-]*) die "wt-commit: slug must be [a-zA-Z0-9_-]";; esac
    emit_phase 2 active
    repo_root=$(git rev-parse --show-toplevel)
    wt_path="$(cd "$repo_root/.." && pwd)/$(basename "$repo_root").worktrees/$slug"
    [ -d "$wt_path" ] || die "wt-commit: lane worktree missing for feat/$slug"
    # [#1 .git repoint — belt] Validate from the TRUSTED main repo that $wt_path is the
    # registered worktree for refs/heads/feat/$slug. `git worktree list --porcelain` emits
    # blank-line-separated records of "worktree <path>" + "branch <ref>"; BOTH must match.
    if ! git -C "$repo_root" worktree list --porcelain | awk -v p="$wt_path" -v b="refs/heads/feat/$slug" '
        /^worktree /{w=substr($0,10)} /^branch /{br=substr($0,8)}
        /^$/{if(w==p&&br==b)found=1; w="";br=""}
        END{if(w==p&&br==b)found=1; exit found?0:1}'; then
      die "wt-commit: $wt_path is not the registered worktree for feat/$slug (possible .git repoint)"
    fi
    # [#1 .git repoint — braces, the real close] NEVER trust $wt_path/.git (the agent has
    # Write in the worktree and can repoint that file via TOCTOU). Derive the TRUSTED linked
    # gitdir from the main repo's admin dirs, which live under the main .git (deploy-owned,
    # agent can't write). Each $common/worktrees/<id>/gitdir contains the absolute path of
    # the worktree's .git file; match it to OUR $wt_path/.git to find OUR admin dir. Then
    # pin --git-dir/--work-tree on EVERY worktree git op so $wt_path/.git is never read.
    # --path-format=absolute so this is independent of the caller's cwd (a bare
    # --git-common-dir can return a relative ".git" that resolves against $PWD, not $repo_root).
    common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
    trusted_gitdir=""
    for d in "$common"/worktrees/*/; do
      [ -f "$d/gitdir" ] || continue
      if [ "$(cat "$d/gitdir")" = "$wt_path/.git" ]; then trusted_gitdir="${d%/}"; break; fi
    done
    [ -n "$trusted_gitdir" ] || die "wt-commit: no registered gitdir for $wt_path"
    # wtgit: run a git command against the TRUSTED admin gitdir + the worktree files,
    # ignoring $wt_path/.git entirely (no TOCTOU on the agent-writable pointer).
    wtgit() { git --git-dir="$trusted_gitdir" --work-tree="$wt_path" "$@"; }
    # [#2 branch] HEAD (read from the trusted gitdir) must be exactly feat/$slug — rejects
    # detached or wrong-branch state. symbolic-ref fails on detached HEAD, so guard it.
    cur_branch=$(wtgit symbolic-ref --short HEAD 2>/dev/null || echo "")
    [ "$cur_branch" = "feat/$slug" ] || die "wt-commit: worktree HEAD is '$cur_branch', expected feat/$slug"
    # [#4 ignore/secret leak] The agent could have edited .gitignore to un-ignore secrets
    # (e.g. .claude/traces/ prompts+contents). Restore the canonical ignore from the
    # committed tree (so an ignored trace dir is honored), stage everything, then as a belt
    # for repos that DON'T ignore traces, drop any staged trace path from the index. (A
    # `:(exclude)` pathspec can't be used here: git hard-errors rc=1 when the excluded path
    # is also gitignored — the two-step add+reset is robust in BOTH cases.)
    wtgit checkout -- .gitignore 2>/dev/null || true
    wtgit add -A
    wtgit reset -q -- .claude/traces 2>/dev/null || true
    # [#5 diff exit code] --cached --quiet: 0=no change (no-op), 1=staged changes (commit),
    # >1=git error (must NOT be treated as "commit"). Capture rc explicitly.
    rc=0; wtgit diff --cached --quiet || rc=$?
    case "$rc" in
      0) emit_subtask "$slug" building 2 ;;  # nothing staged → leave lane as-is for Gate B
      1)
        # [#3 identity/hooks/signing] Pin author identity (the prod `deploy` user may have
        # no global user.name/email), disable signing, point hooksPath at /dev/null, and
        # --no-verify so an inherited core.hooksPath / commit hook can't run or mutate the
        # commit. Set identity via GIT_*_NAME/EMAIL env (not just -c user.*) because an
        # empty inherited GIT_AUTHOR_NAME would otherwise override config and trip "empty
        # ident name". Scoped to this one git call only.
        GIT_AUTHOR_NAME="umbrella-harness" GIT_AUTHOR_EMAIL="harness@umbrella.local" \
        GIT_COMMITTER_NAME="umbrella-harness" GIT_COMMITTER_EMAIL="harness@umbrella.local" \
        wtgit \
          -c user.name="umbrella-harness" \
          -c user.email="harness@umbrella.local" \
          -c commit.gpgsign=false \
          -c core.hooksPath=/dev/null \
          commit --no-verify -q -m "lane $slug: agent build" >&2
        emit_subtask "$slug" building 2
        ;;
      *) die "wt-commit: git diff failed (rc=$rc)" ;;
    esac
    ;;
  wt-verify)
    # Gate B: a lane must be COMMITTED before it can merge — otherwise integ-merge of
    # an empty feat/<slug> is a silent no-op and a do-nothing agent passes unnoticed.
    slug=${2:-}
    [ -n "$slug" ] || die "wt-verify needs a <slug>"
    # In-script charset guard (same as wt.sh new): the daemon already provenance-checks,
    # but this script is also a direct CLI, so $slug must never carry path/ref parts.
    case "$slug" in *[!a-zA-Z0-9_-]*) die "wt-verify: slug must be [a-zA-Z0-9_-]";; esac
    emit_phase 2 active
    repo_root=$(git rev-parse --show-toplevel)
    wt_path="$(cd "$repo_root/.." && pwd)/$(basename "$repo_root").worktrees/$slug"
    if [ ! -d "$wt_path" ]; then
      emit_gate B raised high "lane worktree missing for feat/$slug" "$slug"
      emit_phase 2 blocked; exit 1
    fi
    # --porcelain catches modified, staged AND untracked files (plain `diff` misses
    # untracked). .claude/traces is gitignored, so the agent's own trace won't trip it.
    if [ -n "$(git -C "$wt_path" status --porcelain)" ]; then
      emit_gate B raised high "uncommitted/untracked changes in feat/$slug (agent did not commit)" "$slug"
      emit_phase 2 blocked; exit 1
    fi
    if [ "$(git rev-list --count "$BASE..feat/$slug" 2>/dev/null || echo 0)" -eq 0 ]; then
      emit_gate B raised high "feat/$slug has no commits beyond $BASE (agent produced nothing)" "$slug"
      emit_phase 2 blocked; exit 1
    fi
    emit_gate B clear info "lane feat/$slug committed and clean" "$slug"
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
    echo "usage: harness.sh {budget <plan.jsonl> | wt-new <slug> | wt-commit <slug> | wt-verify <slug> | integ-start | integ-merge <slug> | trace <session> | promote | clean}" >&2
    exit 2
    ;;
esac
