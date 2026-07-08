# Subtask: routing (per-lane model routing — TS spine)

spec: New console/lib/server/route-tier.ts exporting routeModel(brief): "haiku"|"sonnet"|"opus" —
a deterministic keyword heuristic ported VERBATIM from .claude/skills/route-cost/route.py
(TOP regex → opus, CHEAP regex → haiku, else sonnet; case-insensitive; cite route.py as source).
Then wire per-lane models through the daemon (console/lib/server/daemon.ts):
- LaneStep gains `model: "haiku"|"sonnet"|"opus"`.
- planRun(runId, routing, laneBriefs): routing==="auto" ⇒ lane.model = routeModel(brief) per
  lane; explicit "haiku"|"sonnet"|"opus" ⇒ every lane forced to that model. RunPlan.model stays
  (run-global value: decompose agent model + explicit-override source; auto keeps model:"sonnet").
- writePlanFile: each plan.jsonl line prices ITS lane — tier: MODEL_TIER[lane.model],
  rate_usd_per_mtok: TIER_RATE_USD_PER_MTOK[lane.model].
- Build worker (asyncPool callback): pass lane.model to runAgent instead of the run-global
  `model` capture (which goes away). Decompose call unchanged (MODEL_BY_ROUTING[routing]).

owns: console/lib/server/route-tier.ts, console/lib/server/route-tier.test.ts,
      console/lib/server/daemon.ts, console/lib/server/daemon.test.ts

DO NOT change: decompose.ts output contract (no agent-proposed tiers — child-controlled
spend steering), route.ts API fields, contract/types.ts, sandbox/**, bin/gantry, components/**.

acceptance: cd console && npx vitest run — all green including NEW cases:
- route-tier.test.ts: top/cheap/default classifications matching route.py's keywords
  (e.g. "review the security threat model"→opus, "write docs for the README"→haiku,
  "implement the fetch wrapper"→sonnet; case-insensitivity; word-boundary cases \btest\b).
- daemon.test.ts: planRun auto routes per-brief (mixed-tier lanes from mixed briefs);
  explicit routing forces all lanes; plan.jsonl lines carry per-lane tier+rate (writePlan
  seam asserts); runAgent stub receives each lane's OWN model in a multi-lane run.
Also: npx eslint . clean; tsc errors == main baseline (11); repo convention: pure-function
.test.ts vitest, no jsdom.
