# tracehook

spec: make the PostToolUse trace hook work from any cwd
owns: .claude/settings.json, .claude/skills/eval-gate/trace-log.py

Today both are cwd-relative and break when a Bash command cds away from the repo
root: settings.json runs `python3 .claude/skills/eval-gate/trace-log.py` (relative
script path) and trace-log.py writes to `.claude/traces/` (relative output dir).
Fix: settings.json invokes the script via `"$CLAUDE_PROJECT_DIR"`; trace-log.py
anchors its output dir to $CLAUDE_PROJECT_DIR when set, else to the repo root
derived from its own __file__ (three dirs up). Keep the never-block contract
(any failure exits 0). Do not change the trace line format.

acceptance: echo a fake hook payload into trace-log.py with cwd=/tmp and confirm
the line lands in <repo>/.claude/traces/<session>.jsonl; settings.json is valid JSON.
