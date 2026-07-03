# memdocs

spec: README section documenting the memory-os integration
owns: README.md

Add a "Memory (optional)" section to the repo README covering: what memory-os is
(one line, separate repo at ~/claude/memory-os, MCP-level coupling only);
ENABLE_MEMORY_OS flag (default off, nothing changes when unset); the hard
boundaries (orchestrator/daemon-side only — build agents are zero-MCP sandboxed;
writes only via web/lib/memory/proposeFromHarness.ts, summary-only at run
boundaries S0/S3/S5/S7; reads fail open, never block gates A-D); the provisional
human gate (decision/constraint ledgered to data/memory-pending-provisionals.jsonl
until operator confirm); and how to verify (deploy/tier3/conformance-memory.sh,
web vitest). Match the README's existing tone and heading style; keep it tight
(~30-40 lines). Do not touch any other README section.

acceptance: section present, factually consistent with .claude/skills/harness/
SKILL.md "Memory (optional)" and web/lib/memory/proposeFromHarness.ts semantics;
no other README diff hunks.
