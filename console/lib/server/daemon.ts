// console/lib/server/daemon.ts
// Single-slot live run orchestrator — the spawn pipeline behind POST /api/runs. It
// acquires the slot, seeds the run snapshot, then runs harness.sh subcommands via the
// secure bridge (spawnHarness, shell:false, provenance-minted argv). Every structured
// stdout event flows through ONE ingest path:  fold → persist.appendEvent → broker.publish
// (SSE fan-out) → notifier (edge-triggered gate-raised / failed-stuck / completed).
//
// LIVE ONLY. With HARNESS_LIVE unset the daemon is never invoked — the fixture SSE stream
// remains the sole producer, exactly as before (regression-critical). Provenance-bearing
// values (lane slug, plan file) are derived from the SERVER-minted runId, NEVER the brief,
// so minting them is trustworthy (threat model T1). No mem_*/MCP wiring anywhere.

import { createHash } from "crypto";
import { writeFileSync, mkdirSync, realpathSync } from "fs";
import { dirname } from "path";
import { fleetReducer } from "@/lib/contract/events";
import type { Envelope } from "@/lib/contract/events";
import { newRun, initialFleetState, TIER_RATE_USD_PER_MTOK } from "@/lib/contract/types";
import type { FleetState } from "@/lib/contract/types";
import { appendEvent, upsertRun, finalizeRun } from "./persist";
import { publish } from "./broker";
import { notify, notificationsFor } from "./notifier";
import {
  spawnHarness,
  containedPlanFile,
  planAllowDir,
  type HarnessSubcommand,
  type ParsedHarnessEvent,
  type SpawnHarnessOptions,
} from "@/lib/bridge/harness-bridge";
import { mintLane, mintPlanFile } from "@/lib/bridge/registry";

export class SlotTakenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SlotTakenError";
  }
}
/** A harness subcommand exited non-zero (e.g. a raised gate / merge conflict). */
export class HarnessExitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HarnessExitError";
  }
}

// Single slot (threat model TB-2): one live harness run at a time — every git op is serial.
let slotRunId: string | null = null;
function acquireSlot(runId: string): boolean {
  if (slotRunId) return false;
  slotRunId = runId;
  return true;
}
function releaseSlot(runId: string): void {
  if (slotRunId === runId) slotRunId = null;
}
export function currentSlot(): string | null {
  return slotRunId;
}
/** Test-only: force-release the slot between cases. */
export function _resetSlot(): void {
  slotRunId = null;
}

export type Routing = "auto" | "haiku" | "sonnet" | "opus";
const MODEL_BY_ROUTING: Record<Routing, "haiku" | "sonnet" | "opus"> = {
  auto: "sonnet",
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};
const MODEL_TIER: Record<"haiku" | "sonnet" | "opus", "cheap" | "default" | "top"> = {
  haiku: "cheap",
  sonnet: "default",
  opus: "top",
};

export interface RunPlan {
  runId: string;
  slug: string;
  planFile: string;
  model: "haiku" | "sonnet" | "opus";
}

/**
 * Build the live plan from the SERVER runId. Hash the FULL runId → a fixed-length,
 * validator-safe id so distinct runs never collide on a lane slug / plan file. The brief
 * NEVER contributes to a provenance-bearing value.
 * ponytail: single generic lane (cap: one lane); real brief → N file-disjoint lanes is the
 * decompose agent's job — out of scope for this lane (no agent-exec here).
 */
export function planRun(runId: string, routing: Routing): RunPlan {
  const id = createHash("sha1").update(runId).digest("hex").slice(0, 16);
  return {
    runId,
    slug: `lane-${id}`, // ≤ SLUG cap; starts with a letter
    planFile: `plan-${id}.jsonl`, // bare filename
    model: MODEL_BY_ROUTING[routing] ?? "sonnet",
  };
}

// Materialize the route-cost plan.jsonl Gate A (`harness.sh budget`) prices, into the SAME
// contained allow-dir path the bridge passes to budget. Conservative fixed estimate.
function writePlanFile(plan: RunPlan): void {
  const abs = containedPlanFile(plan.planFile);
  const dir = dirname(abs);
  mkdirSync(dir, { recursive: true });
  // Symlink guard (threat model T5, depth): containedPlanFile's containment is LEXICAL; a
  // symlink planted inside the allow-dir could still redirect the write. realpath the
  // materialized dir and re-verify it is exactly the allow-dir before writing.
  if (realpathSync(dir) !== realpathSync(planAllowDir())) {
    throw new Error("plan dir escapes allow-dir after realpath resolution");
  }
  const line = JSON.stringify({
    task: plan.slug,
    tier: MODEL_TIER[plan.model],
    in_ktok: 40,
    out_ktok: 8,
    cached_ktok: 30,
    rate_usd_per_mtok: TIER_RATE_USD_PER_MTOK[plan.model],
  });
  // O_CREAT|O_EXCL ("wx"): never overwrite or follow a pre-existing file/symlink at the plan
  // path. The runId is server-random so a fresh run never legitimately collides — an EEXIST
  // here is a signal (a planted file), not a normal condition.
  writeFileSync(abs, line + "\n", { flag: "wx" });
}

export interface StartRunInput {
  runId: string; // server-generated (route); NEVER client-supplied
  projectId: string;
  projectName: string;
  brief: string;
  routing?: Routing;
}

export interface StartRunOptions {
  /** Force live. Defaults to HARNESS_LIVE === "1". */
  live?: boolean;
  /** TEST-ONLY seam: injectable harness child spawn. IGNORED unless NODE_ENV==="test". */
  spawnFn?: SpawnHarnessOptions["spawnFn"];
  /** TEST-ONLY seam: injectable plan-file writer (avoid real fs). IGNORED unless test. */
  writePlan?: (plan: RunPlan) => void;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Start a live run. Acquires the single slot (throws SlotTakenError if taken), seeds the
 * snapshot, and launches the background producer. Returns immediately; progress is observed
 * via the broker (SSE stream) + persistence. Provenance is minted from server values before
 * any side effect. On any failure a terminal `failed` snapshot is persisted so clients never
 * see a forever-"running" run.
 */
export function startRun(input: StartRunInput, opts: StartRunOptions = {}): void {
  const { runId, projectId, projectName, brief } = input;
  const routing: Routing = input.routing ?? "auto";
  if (!acquireSlot(runId)) {
    throw new SlotTakenError("slot already occupied");
  }

  const testSeam = process.env.NODE_ENV === "test";
  const live = opts.live ?? process.env.HARNESS_LIVE === "1";
  const spawnFn = testSeam ? opts.spawnFn : undefined;
  const writePlan = (testSeam && opts.writePlan) || writePlanFile;

  // ONE ingest path: fold → persist → broadcast → notify (edge-triggered).
  let fleet: FleetState = initialFleetState;
  const ingest = (env: Envelope): void => {
    const before = fleet.runs[env.runId];
    fleet = fleetReducer(fleet, env);
    const after = fleet.runs[env.runId];
    try {
      appendEvent(env);
    } catch {
      // persistence is best-effort within the live pipeline; broadcast must still run
    }
    publish(env); // SSE fan-out to connected fleet clients
    if (after) {
      try {
        upsertRun(after);
      } catch {
        /* snapshot best-effort */
      }
      for (const n of notificationsFor(before, after)) void notify(n);
    }
  };

  const toEnvelope = (parsed: ParsedHarnessEvent): Envelope => {
    const { type, ...payload } = parsed;
    // The whitelist guarantees payload matches the Envelope payload for `type`, but the
    // parsed shape is structurally generic — cast through unknown to the discriminated union.
    return { runId, projectId, agentId: "harness", ts: nowSec(), type, payload } as unknown as Envelope;
  };
  const runSub = async (sub: HarnessSubcommand): Promise<void> => {
    const { code } = await spawnHarness(sub, (parsed) => ingest(toEnvelope(parsed)), { spawnFn });
    if (code !== 0) throw new HarnessExitError(`harness '${sub.cmd}' exited with code ${code}`);
  };

  // Seed the run identity so persistence + reconnecting clients see it immediately.
  ingest({
    runId,
    projectId,
    agentId: "operator",
    ts: nowSec(),
    type: "sync",
    payload: { run: newRun(runId, projectId, projectName, brief, nowSec()) },
  });

  void (async () => {
    try {
      if (live) {
        const plan = planRun(runId, routing);
        // Pre-mint provenance up front so a malformed plan fails BEFORE any side effect.
        mintPlanFile(plan.planFile);
        mintLane(plan.slug);
        writePlan(plan);

        await runSub({ cmd: "budget", planFile: plan.planFile }); // Gate A
        await runSub({ cmd: "integ-start" });
        await runSub({ cmd: "wt-new", slug: plan.slug });
        // NOTE: the agent BUILD (Phase 2) is out of scope for this lane (no agent-exec).
        // A live run therefore commits/verifies an unbuilt worktree — Gate B raises on a
        // do-nothing lane, which is the honest signal until the decompose+build agent lands.
        await runSub({ cmd: "wt-commit", slug: plan.slug });
        await runSub({ cmd: "wt-verify", slug: plan.slug }); // Gate B
        await runSub({ cmd: "integ-merge", slug: plan.slug }); // Gate C
        ingest(toEnvelope({ type: "health", verdict: "healthy", lifecycle: "done" }));
      }
      finalizeRun(runId, "done", nowSec());
    } catch (err) {
      // Producer failed mid-run: log the reason (server-side, no secrets) and persist a
      // terminal failed outcome. Emit a failed-health envelope so the notifier fires.
      console.error(`[daemon] run ${runId} failed:`, err instanceof Error ? err.message : String(err));
      ingest(toEnvelope({ type: "health", verdict: "stuck", lifecycle: "failed" }));
      try {
        finalizeRun(runId, "failed", nowSec());
      } catch {
        /* best-effort */
      }
    } finally {
      // Return the main checkout to BASE on every live finalize so it's never stranded on
      // `integration`. Best-effort; never skips the slot release.
      if (live) {
        try {
          await runSub({ cmd: "reset-base" });
        } catch (e) {
          console.error(`[daemon] run ${runId} reset-base failed:`, e instanceof Error ? e.message : String(e));
        }
      }
      releaseSlot(runId);
    }
  })();
}
