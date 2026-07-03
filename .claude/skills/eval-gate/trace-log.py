#!/usr/bin/env python3
"""PostToolUse hook: append one compact trace line per tool call.

Reads the Claude Code hook payload (JSON) on stdin and writes a line to
.claude/traces/<session>.jsonl. Deliberately non-blocking: any failure exits 0
so a logging problem never breaks the agent's tool flow.
"""
import sys, os, json, time, hashlib


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
        session = str(data.get("session_id", "unknown"))
        tool = data.get("tool_name", "?")
        # stable signature of the input so identical repeated calls (loops) are detectable
        tin = json.dumps(data.get("tool_input", {}), sort_keys=True, default=str)
        sig = hashlib.sha1(tin.encode()).hexdigest()[:8]
        # ponytail: repo root = $CLAUDE_PROJECT_DIR, else three dirs up from this
        # file (.claude/skills/eval-gate/trace-log.py -> repo root). Revisit if
        # this file ever moves to a different depth under the repo.
        repo_root = os.environ.get("CLAUDE_PROJECT_DIR") or os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        )
        out_dir = os.path.join(repo_root, ".claude", "traces")
        os.makedirs(out_dir, exist_ok=True)
        line = {"ts": round(time.time(), 3), "tool": tool, "sig": sig}
        with open(os.path.join(out_dir, f"{session}.jsonl"), "a") as f:
            f.write(json.dumps(line) + "\n")
    except Exception:
        pass  # logging must never block the tool call
    return 0


if __name__ == "__main__":
    sys.exit(main())
