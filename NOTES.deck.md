# deck
spec: Observability deck at console/app/deck (deep-linkable, ?run= filter): trace forensics explorer — searchable, filters (run/lane/agent/event type), virtualized list; tool-call detail pane w/ full args/outputs/timing (expandable, mono); diff viewer per worktree commit (git show via server route, read-only); eval results panel (regression pass/fail, capability scores); charts: token burn over time (line), per-lane comparison (bars), eval history (line/dots) — axes at zero, no dual-axis, no pies, CRT palette. Data: trace events from store + a server route reading .claude/traces/*.jsonl (read-only, path-validated).
owns: console/app/deck/**, console/components/deck/**
acceptance: cd console && npx vitest run passes (new: filter/search logic, trace parse, path validation) && npm run build passes && /deck SSR-renders explorer on fixture data.
read: DESIGN_SPEC.md §6 (interactivity, chart mapping, forensics floor), §5 states. Contract in console/lib/contract/.
