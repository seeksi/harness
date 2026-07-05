#!/usr/bin/env python3
"""PostToolUse hook: warn at a soft context-fill threshold, direct a handoff at
the hard one.

Reads the Claude Code hook payload (JSON) on stdin, estimates the session's
context fill from the transcript's last main-thread assistant usage, and emits
feedback to the model on upward threshold crossings only (debounced via a
sidecar state file). Deliberately non-blocking: any failure exits 0 so a guard
problem never breaks the agent's tool flow.
"""
import sys, os, json

# ponytail: duplicated from web/lib/contract/types.ts CONTEXT_SOFT/CONTEXT_HARD
# (cross-language). Env-overridable for tests/tuning.
SOFT = float(os.environ.get("CONTEXT_GUARD_SOFT", "0.60"))
HARD = float(os.environ.get("CONTEXT_GUARD_HARD", "0.75"))
WINDOW = int(os.environ.get("CONTEXT_GUARD_WINDOW", "200000"))

HANDOFF_TEMPLATE = """# HANDOFF — <task> — <ISO timestamp>
## Current state
<what is DONE and verified; what is in progress and exactly where it stops>
## Decisions
<decisions made + one-line why, so the next agent doesn't relitigate>
## Files touched
<path — what changed, one line each>
## Next steps
<ordered, concrete; first item is the resume point>
## Dead ends / open questions
<approaches tried and abandoned (why), unresolved questions>"""


def last_fill(transcript_path):
    """Token fill from the last main-thread assistant message's usage, or None."""
    size = os.path.getsize(transcript_path)
    with open(transcript_path, "rb") as f:
        # ponytail: tail-scan (256KB) instead of full parse — transcripts grow to
        # tens of MB; a >256KB gap between assistant turns just skips one check.
        f.seek(max(0, size - 262_144))
        tail = f.read().decode("utf-8", errors="replace")
    fill = None
    for line in tail.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue  # first line may be truncated by the seek
        if rec.get("type") != "assistant" or rec.get("isSidechain"):
            continue  # sidechain/subagent usage is not the main session's fill
        usage = (rec.get("message") or {}).get("usage")
        if usage:
            fill = (
                usage.get("input_tokens", 0)
                + usage.get("cache_read_input_tokens", 0)
                + usage.get("cache_creation_input_tokens", 0)
            )
    return fill


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
        session = str(data.get("session_id", "unknown"))
        transcript = data.get("transcript_path")
        if not transcript:
            return 0
        fill = last_fill(transcript)
        if fill is None:
            return 0
        ratio = fill / WINDOW
        tier = "hard" if ratio >= HARD else "soft" if ratio >= SOFT else "none"

        # Debounce: emit only on an upward tier crossing; re-arm when the fill
        # drops back below soft (/clear or compaction reusing the session file).
        repo_root = os.environ.get("CLAUDE_PROJECT_DIR") or os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        )
        state_dir = os.path.join(repo_root, ".claude", "context-guard")
        os.makedirs(state_dir, exist_ok=True)
        state_file = os.path.join(state_dir, f"{session}.json")
        try:
            with open(state_file) as f:
                prev = json.load(f).get("tier", "none")
        except Exception:
            prev = "none"
        rank = {"none": 0, "soft": 1, "hard": 2}
        if rank[tier] <= rank[prev]:
            if tier != prev:  # tier dropped (compaction//clear) → re-arm silently
                with open(state_file, "w") as f:
                    json.dump({"tier": tier}, f)
            return 0
        with open(state_file, "w") as f:
            json.dump({"tier": tier}, f)

        pct = round(ratio * 100)
        if tier == "hard":
            print(json.dumps({
                "decision": "block",
                "reason": (
                    f"CONTEXT GUARD — HARD LIMIT: this session's context window is {pct}% full "
                    f"(~{fill} of {WINDOW} tokens; hard limit {round(HARD * 100)}%). Stop taking on "
                    "new work now. 1) Write HANDOFF.md at the repo root using exactly this template:\n\n"
                    f"{HANDOFF_TEMPLATE}\n\n"
                    "2) Then finish your reply by telling the user to start a fresh session opened "
                    "with NOTES.md (or the active NOTES.<slug>.md) plus HANDOFF.md as its opening "
                    "context. Do not start new edits after writing HANDOFF.md."
                ),
            }))
        elif tier == "soft":
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": (
                        f"CONTEXT GUARD — soft limit: this session's context window is {pct}% full "
                        f"(soft limit {round(SOFT * 100)}%, hard limit {round(HARD * 100)}% at which "
                        "you must stop and write HANDOFF.md). Keep working, but checkpoint now: "
                        "append current state/decisions/next steps to NOTES.md and keep "
                        "handoff-relevant state written down as you go."
                    ),
                }
            }))
    except Exception:
        pass  # the guard must never block the tool call
    return 0


if __name__ == "__main__":
    sys.exit(main())
