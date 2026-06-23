#!/usr/bin/env bash
# Make the HARNESS skills globally available by symlinking each skill under
# .claude/skills/ into ~/.claude/skills/ (this repo stays the canonical source).
# Idempotent. Re-run anytime. Use --uninstall to remove the symlinks.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/.claude/skills"
DEST="$HOME/.claude/skills"

if [ "${1:-}" = "--uninstall" ]; then
  for link in "$DEST"/*; do
    [ -L "$link" ] || continue
    case "$(readlink -f "$link")" in "$SRC"/*) rm -f "$link"; echo "removed $(basename "$link")";; esac
  done
  exit 0
fi

[ -d "$SRC" ] || { echo "no skills found at $SRC"; exit 1; }
mkdir -p "$DEST"
for dir in "$SRC"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  ln -sfn "${dir%/}" "$DEST/$name"
  echo "✓ $name -> ${dir%/}"
done
echo "done — restart Claude Code sessions to pick up the skills"
