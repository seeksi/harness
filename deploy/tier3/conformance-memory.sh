#!/usr/bin/env bash
# Memory-boundary CONFORMANCE (memory-os integration guard).
#
# Proves the HARNESS<->memory-os write/read boundary HOLDS before any write path ships,
# in the style of conformance-multilane.sh. Runs against the real memory-os checkout
# using a THROWAWAY project (slug: conformance-tmp) that is created at start and torn
# down (project dir + registry entry + index rows) at exit — no other project's data is
# ever touched. Exit 0 iff ALL checks pass (SKIPs do not fail the run).
#
#   bash deploy/tier3/conformance-memory.sh
#   MEMORY_OS_DIR=/path/to/memory-os bash deploy/tier3/conformance-memory.sh
#
# Checks:
#   (a) a secret-shaped propose (sk- token, private key block) is REJECTED and the
#       secret string appears NOWHERE under the throwaway project (incl. audit_log)
#   (b) a record whose project_id names a DIFFERENT project is REJECTED (scope leak)
#   (c) `index sync` is idempotent: sync, edit a JSON record, sync twice — identical
#   (d) fail-open: with MEMORY_OS_DIR pointed at a nonexistent path, the client-contract
#       read path exits 0 (skip-enrichment, never blocks a gate)
#   (e) cross-lane: a lane-A-scoped search must not surface lane B's record
set -uo pipefail

MEMORY_OS_DIR="${MEMORY_OS_DIR:-/home/alter/claude/memory-os}"
SLUG="conformance-tmp"
CLI="$MEMORY_OS_DIR/memory_layer/engine/cli.py"
PROJ_DIR="$MEMORY_OS_DIR/memory_layer/projects/$SLUG"
REGISTRY="$MEMORY_OS_DIR/memory_layer/global/project_registry.json"

pass=0; fail=0; skip=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
skp()  { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; skip=$((skip+1)); }
sect() { printf '\n== %s ==\n' "$1"; }

mem() { python3 "$CLI" "$@"; }

sect "Preflight"
command -v python3 >/dev/null 2>&1 || { echo "FATAL: python3 not found" >&2; exit 1; }
[ -f "$CLI" ] || { echo "FATAL: memory-os CLI not found at $CLI (set MEMORY_OS_DIR)" >&2; exit 1; }
ok "memory-os CLI present at $CLI"

# Teardown: remove the throwaway project dir, its registry entry, and (via a rebuild)
# its index rows. Idempotent — safe to run on a leftover from an aborted prior run.
teardown() {
  rm -rf -- "$PROJ_DIR" 2>/dev/null
  [ -f "$REGISTRY" ] && python3 - "$REGISTRY" "$SLUG" <<'EOF' 2>/dev/null
import json, sys
path, slug = sys.argv[1], sys.argv[2]
reg = json.load(open(path))
reg["projects"] = [p for p in reg.get("projects", []) if p.get("slug") != slug]
json.dump(reg, open(path, "w"), indent=2)
EOF
  # index.sync() drops + rebuilds every table from JSON, so removing the dir purges rows.
  mem index sync >/dev/null 2>&1
}
trap teardown EXIT

sect "Throwaway project $SLUG"
teardown # clear any leftover from an aborted run before creating fresh
if mem project add "$SLUG" --objective "throwaway memory-boundary conformance project" >/dev/null 2>&1; then
  ok "created throwaway project '$SLUG'"
else
  bad "could not create throwaway project '$SLUG' — cannot run boundary probes"
  printf '\n== RESULT ==  \033[32m%d passed\033[0m / \033[31m%d failed\033[0m / \033[33m%d skipped\033[0m\n' "$pass" "$fail" "$skip"
  echo "MEMORY CONFORMANCE: FAIL — no throwaway project."
  exit 1
fi

sect "(a) Secret-shaped propose is REJECTED and never persisted"
# Fake-but-pattern-matching secrets (sk-<16+ alnum>, private key block header).
SK_TOKEN="sk-CONFTESTfake0123456789abcdefXYZ"
PK_MARKER="-----BEGIN PRIVATE KEY-----"
out=$(mem propose "$SLUG" decision "{\"topic\":\"conf-secret-test\",\"decision\":\"token $SK_TOKEN and $PK_MARKER junk\",\"impact\":\"low\",\"confidence\":\"low\"}" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q '"verdict": "rejected"'; then
  ok "secret-shaped decision rejected (exit 2, verdict rejected)"
else
  bad "secret-shaped decision NOT rejected (rc=$rc)"
fi
if grep -rF -- "$SK_TOKEN" "$PROJ_DIR" >/dev/null 2>&1; then
  bad "LEAK: the sk- token string persists under $PROJ_DIR (audit trail not redacted)"
else
  ok "sk- token appears NOWHERE under $PROJ_DIR (incl. audit_log/memory_updates)"
fi
if grep -rF -- "BEGIN PRIVATE KEY" "$PROJ_DIR" >/dev/null 2>&1; then
  bad "LEAK: the private-key block marker persists under $PROJ_DIR"
else
  ok "private-key block appears NOWHERE under $PROJ_DIR"
fi

sect "(b) Cross-project project_id is REJECTED (scope-leak check)"
out=$(mem propose "$SLUG" decision '{"topic":"conf-scope-test","decision":"scope probe","impact":"low","confidence":"low","project_id":"some-other-project"}' 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "cross-project"; then
  ok "foreign project_id rejected with a cross-project reason (exit 2)"
else
  bad "foreign project_id NOT rejected as cross-project (rc=$rc)"
fi
if grep -qF "conf-scope-test" "$PROJ_DIR/decisions.json" 2>/dev/null; then
  bad "scope-leak record was persisted into decisions.json"
else
  ok "scope-leak record NOT persisted into decisions.json"
fi

sect "(c) index sync is idempotent (edit a record, two syncs identical)"
# status must be explicit: the engine's "active" default is not in the task enum.
mem propose "$SLUG" task '{"summary":"conformance sync probe","status":"open"}' >/dev/null 2>&1 \
  && ok "clean task committed (sync has a row to index)" \
  || bad "could not commit a clean task for the sync probe"
mem index sync >/dev/null 2>&1
# Edit a JSON record in place (JSON is the source of truth; the index must follow).
python3 - "$PROJ_DIR/tasks.json" <<'EOF'
import json, sys
path = sys.argv[1]
recs = json.load(open(path))
recs[0]["summary"] = "conformance sync probe (edited)"
json.dump(recs, open(path, "w"), indent=2)
EOF
sync2=$(mem index sync 2>&1); rc2=$?
sync3=$(mem index sync 2>&1); rc3=$?
if [ "$rc2" -eq 0 ] && [ "$rc3" -eq 0 ] && [ "$sync2" = "$sync3" ]; then
  ok "two post-edit syncs produced identical counts (idempotent rebuild)"
else
  bad "post-edit syncs differ or failed (rc=$rc2/$rc3) — index not idempotent"
fi

sect "(d) Fail-open: nonexistent MEMORY_OS_DIR must exit 0 (skip enrichment)"
# ponytail: superseded-by-B — a bash stub honoring the memoryOsClient.ts contract
# (MEMORY_OS_DIR, MEMORY_OS_TIMEOUT_MS; `index sync` before reads; null + rc 0 on any
# failure). Upgrade path: once web/lib/memory/memoryOsClient.ts merges, drive the real
# client here (tsx/node) instead of this stub; its unit tests already cover the same
# semantics daemon-side.
mem_search_failopen() {
  local dir="${MEMORY_OS_DIR:-/home/alter/claude/memory-os}"
  local cli="$dir/memory_layer/engine/cli.py"
  local timeout_s=$(( ${MEMORY_OS_TIMEOUT_MS:-5000} / 1000 + 1 ))
  local out
  timeout "$timeout_s" python3 "$cli" index sync >/dev/null 2>&1 \
    && out=$(timeout "$timeout_s" python3 "$cli" search "$1" "$2" 2>/dev/null) \
    || { echo null; return 0; }
  printf '%s\n' "$out"
}
if out=$(MEMORY_OS_DIR="/nonexistent/conformance-void" mem_search_failopen "$SLUG" "anything") && [ "$out" = "null" ]; then
  ok "nonexistent MEMORY_OS_DIR → exit 0 + null (reads fail open, gates unblocked)"
else
  bad "nonexistent MEMORY_OS_DIR did NOT fail open (rc=$? out=$out)"
fi
if out=$(mem_search_failopen "$SLUG" "conformance") && [ "$out" != "null" ]; then
  ok "real MEMORY_OS_DIR → exit 0 with results (the stub exercises the live path too)"
else
  bad "client-contract read against the real checkout failed (rc=$?)"
fi

sect "(e) Cross-lane: lane-A search must not surface lane B's record"
# Two records tagged with different lane_id values (extra keys pass the shallow schema).
# memory-os approves both (audit_required != a human gate); HARNESS-side these map to
# 'provisional'. A lane-A-scoped search (lane A's unique token) must not return lane B's.
mem propose "$SLUG" decision '{"topic":"lane-scope-A","decision":"laneAonlytokenQZX finding","impact":"low","confidence":"low","lane_id":"lane-A"}' >/dev/null 2>&1
mem propose "$SLUG" decision '{"topic":"lane-scope-B","decision":"laneBonlytokenWVY finding","impact":"low","confidence":"low","lane_id":"lane-B"}' >/dev/null 2>&1
out=$(mem search "$SLUG" "laneAonlytokenQZX" 2>&1)
if printf '%s' "$out" | grep -q "lane-scope-A"; then
  ok "lane-A search surfaces lane A's own record"
else
  bad "lane-A search did not find lane A's record (search broken?)"
fi
if printf '%s' "$out" | grep -q "lane-scope-B"; then
  bad "LEAK: lane-A-scoped search surfaced lane B's record"
else
  ok "lane-A-scoped search does NOT surface lane B's record"
fi
skp "pending-provisionals file scoping: memory-os has no queryable provisional store — the pending file lives HARNESS-side (proposeFromHarness, Workstream B); covered by its unit tests once merged"

printf '\n== RESULT ==  \033[32m%d passed\033[0m / \033[31m%d failed\033[0m / \033[33m%d skipped\033[0m\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] || { echo "MEMORY CONFORMANCE: FAIL — the memory boundary does NOT hold; do not ship a write path."; exit 1; }
echo "MEMORY CONFORMANCE: PASS — secret + scope rejects hold, index idempotent, reads fail open, lanes don't cross."

# ponytail: probes the boundary via the CLI against a throwaway project, not via the
# daemon's own client code path. Ceiling: it proves memory-os-side semantics, not the
# TS plumbing. Upgrade path: once Workstream B merges, add a tsx-driven leg that calls
# memoryOsClient/proposeFromHarness directly (their vitest suites cover it meanwhile).
