# Memory-integration follow-ups (trace hook cwd, provisional confirm CLI, README docs) — base: main
project: harness

## Subtasks
- slug: tracehook   spec: "make the PostToolUse trace hook work from any cwd"                    owns: .claude/settings.json, .claude/skills/eval-gate/trace-log.py   tier: cheap
- slug: memconfirm  spec: "operator CLI to list/confirm/reject pending provisional memory records" owns: web/lib/memory/pendingLedger.ts, web/lib/memory/pendingLedger.test.ts, web/scripts/memory-pending.mjs   tier: default
- slug: memdocs     spec: "README section documenting the memory-os integration"                  owns: README.md   tier: cheap
