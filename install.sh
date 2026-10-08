#!/usr/bin/env bash
# Make the HARNESS skills globally available by symlinking each skill under
# .claude/skills/ into ~/.claude/skills/ (this repo stays the canonical source),
# and put the `gantry` CLI on PATH (~/.local/bin/gantry -> bin/gantry).
# Idempotent. Re-run anytime. Use --uninstall to remove the symlinks.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/.claude/skills"
DEST="$HOME/.claude/skills"
BIN_SRC="$HERE/bin/gantry"
BIN_DEST="$HOME/.local/bin/gantry"

if [ "${1:-}" = "--uninstall" ]; then
  for link in "$DEST"/*; do
    [ -L "$link" ] || continue
    case "$(readlink -f "$link")" in "$SRC"/*) rm -f "$link"; echo "removed $(basename "$link")";; esac
  done
  if [ -L "$BIN_DEST" ] && [ "$(readlink -f "$BIN_DEST")" = "$(readlink -f "$BIN_SRC")" ]; then
    rm -f "$BIN_DEST"; echo "removed gantry"
  fi
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

# Runtime copy of the lane guard mod. A COPY, not a symlink: the console loads it into
# headless lanes via --plugin-dir and refuses a path that resolves into agent-writable
# territory; the repo checkout may be exactly that in direct mode. Re-run after editing the mod.
MOD_SRC="$HERE/mods/trajectory-guard"
MOD_DEST="$HOME/.gantry/mods/trajectory-guard"
if [ -d "$MOD_SRC" ]; then
  # Regular files only (find -type f never follows links): a symlink inside the mod could
  # resolve back into agent-writable territory past the console's plugin-root realpath check.
  rm -rf "$MOD_DEST" && mkdir -p "$MOD_DEST"
  (cd "$MOD_SRC" && find . -type f ! -path './.claude-plugin/types/*' -exec install -D -m 0644 {} "$MOD_DEST/{}" \;)
  echo "✓ trajectory-guard -> $MOD_DEST"
fi

mkdir -p "$(dirname "$BIN_DEST")"
if [ -e "$BIN_DEST" ] || [ -L "$BIN_DEST" ]; then
  if [ ! -L "$BIN_DEST" ] || [ "$(readlink -f "$BIN_DEST")" != "$(readlink -f "$BIN_SRC")" ]; then
    echo "refusing to overwrite $BIN_DEST (exists and is not a gantry symlink into this repo)" >&2
    exit 1
  fi
fi
ln -sfn "$BIN_SRC" "$BIN_DEST"
echo "✓ gantry -> $BIN_SRC"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "note: $HOME/.local/bin is not on PATH";; esac

cat <<'EOF'
done — restart Claude Code sessions to pick up the skills

gantry quickstart:
  gantry up                       # start the console LIVE (HARNESS_LIVE, ENABLE_AGENT_EXEC,
                                  # AGENT_ALLOW_DIRECT, AGENT_CLI_PATH auto-resolved from PATH,
                                  # LANE_CONCURRENCY via --lanes 1..4; --fixture for demo mode)
  gantry run "<brief>"            # launch a run + stream its gates/phases to the terminal
  gantry run "x" --lane a --lane b  # multi-lane (1..4 lane briefs)
  gantry status                   # live flag, slot, recent runs per project
Env: GANTRY_URL overrides the console base URL (default http://127.0.0.1:3000);
AGENT_CLI_PATH pins the claude binary; AGENT_HOME is a legacy override (leave unset —
isolated per-lane homes at ~/.gantry/agent-homes/<slug> are the default).
EOF
