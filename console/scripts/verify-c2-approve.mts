// scripts/verify-c2-approve.mts — C2 approve-path end-to-end verification.
// Seeds a THROWAWAY run with a raised Gate B (same shape the daemon persists),
// POSTs an operator "approved" verdict THROUGH the live :3001 server (real CSRF,
// real route), asserts 200 + the decision event persisted, then deletes the seed.
// Leaves the real run 55af... untouched so the operator's phone tap is genuine.
import { upsertRun, eventsSince } from "@/lib/server/persist";
import Database from "better-sqlite3";

const BASE = process.env.C2_BASE ?? "http://100.72.193.64:3001";
const RUN = "c2verifyseed000000000000";
const PROJECT = "harness-c2verify";

// 1. Seed: minimal RunState with a raised Gate B (getSnapshot reads this back).
upsertRun({
  runId: RUN,
  projectId: PROJECT,
  brief: "C2 approve-path verify (throwaway)",
  startedAt: 1783528900,
  gates: [{ id: "B", status: "raised", severity: "warn", summary: "wt-verify — raised" }],
} as any);

// 2. Operator verdict through the LIVE server — exact headers a browser sends.
const res = await fetch(`${BASE}/api/runs/${RUN}/gate`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-harness-request": "1",
    origin: BASE,
  },
  body: JSON.stringify({ gateId: "B", status: "approved" }),
});
const json = await res.json();
console.log("POST /gate ->", res.status, JSON.stringify(json));

// 3. Assert the decision was persisted as a gate event on this run.
const evs = eventsSince(RUN, 0);
const decision = evs.find((e) => e.env.type === "gate" && (e.env.payload as any).status === "approved");
console.log("persisted gate events:", JSON.stringify(evs.map((e) => ({ type: e.env.type, ...(e.env.payload as any) }))));

// 4. Clean up the seed row + its events (keep the live DB tidy).
const db = new Database("./data/console.db");
db.prepare("DELETE FROM events WHERE run_id = ?").run(RUN);
db.prepare("DELETE FROM runs WHERE id = ?").run(RUN);
db.close();

const pass = res.status === 200 && json.ok === true && !!decision;
console.log(pass ? "C2 APPROVE PATH: PASS ✓" : "C2 APPROVE PATH: FAIL ✗");
process.exit(pass ? 0 : 1);
