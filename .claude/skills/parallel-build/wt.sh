#!/usr/bin/env sh
# Worktree lifecycle helper for parallel agent builds.
# Worktrees live in a sibling dir (../<repo>.worktrees/<slug>) so git never
# nests/tracks them. Branches are feat/<slug> off the integration base.
#
# Usage:
#   wt.sh new <slug> [base]   create branch feat/<slug> off base (default: main) + worktree
#   wt.sh list                show worktrees and their branches
#   wt.sh clean [into]        remove worktrees whose branch is merged into `into` (default: main)
set -eu

repo_root=$(git rev-parse --show-toplevel)
repo_name=$(basename "$repo_root")
# canonicalize parent so paths match git worktree list output (no `..` segment)
wt_dir="$(cd "$repo_root/.." && pwd)/$repo_name.worktrees"

cmd=${1:-}
case "$cmd" in
  new)
    slug=${2:-}
    base=${3:-main}
    [ -n "$slug" ] || { echo "wt: new needs a <slug>" >&2; exit 2; }
    case "$slug" in *[!a-zA-Z0-9_-]*) echo "wt: slug must be [a-zA-Z0-9_-]" >&2; exit 2;; esac
    branch="feat/$slug"
    git show-ref --verify --quiet "refs/heads/$branch" && { echo "wt: branch $branch exists" >&2; exit 1; }
    path="$wt_dir/$slug"
    [ -e "$path" ] && { echo "wt: path $path exists" >&2; exit 1; }
    mkdir -p "$wt_dir"
    git worktree add -b "$branch" "$path" "$base" >&2
    echo "$path"   # stdout = the worktree path, so callers can cd into it
    ;;
  list)
    git worktree list
    ;;
  clean)
    into=${2:-main}
    git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch /{print p" "$2}' \
    | while read -r path ref; do
        case "$path" in "$wt_dir"/*) ;; *) continue;; esac   # only our worktrees
        branch=${ref#refs/heads/}
        if git merge-base --is-ancestor "$branch" "$into" 2>/dev/null; then
          echo "removing merged worktree: $path ($branch)"
          git worktree remove "$path" --force
          git branch -d "$branch" 2>/dev/null || true
        else
          echo "keeping unmerged: $path ($branch)"
        fi
      done
    git worktree prune
    rmdir "$wt_dir" 2>/dev/null || true   # drop the parent dir if now empty
    ;;
  *)
    echo "usage: wt.sh {new <slug> [base] | list | clean [into]}" >&2
    exit 2
    ;;
esac
