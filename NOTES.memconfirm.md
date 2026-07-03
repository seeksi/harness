# memconfirm

spec: operator CLI to list/confirm/reject pending provisional memory records
owns: web/lib/memory/pendingLedger.ts, web/lib/memory/pendingLedger.test.ts, web/scripts/memory-pending.mjs

Context: web/lib/memory/proposeFromHarness.ts appends decision/constraint records
to data/memory-pending-provisionals.jsonl (MEMORY_PENDING_PATH overridable) with
operator_confirmed:false — memory-os has already persisted them; this ledger is the
HARNESS-side human gate. Build: pendingLedger.ts with listPending()/confirm(id)/
reject(id) rewriting the JSONL (confirm => operator_confirmed:true; reject =>
rejected:true AND best-effort supersede of the memory-os record via runMemCli,
fail-open — never throw, follow proposeFromHarness idiom). Entries are keyed by
update_id. A thin CLI wrapper web/scripts/memory-pending.mjs (list|confirm <id>|
reject <id>) prints JSON. Import-only from memoryOsClient; do NOT edit
proposeFromHarness.ts or memoryOsClient.ts.

acceptance: vitest pendingLedger.test.ts green (temp ledger file: list shows
unconfirmed only, confirm flips the flag, reject marks + tolerates memory-os
being unreachable); npx tsc --noEmit clean.
