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
import { mintLane, mintPlanFile, mintSession } from "@/lib/bridge/registry";
import {
  runAgentInSandbox,
  relocateTrace,
  removeAgentHome,
  worktreePathFor,
  laneUser,
  DEFAULT_TOOLS,
  type RunAgentInSandboxOptions,
  type RunAgentInSandboxResult,
} from "@/lib/sandbox";

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

// The agent-reported usage.model is a free child-controlled string. It is ingested
// DIRECTLY into the HUD usage envelope (it does NOT pass through the harness stdout schema
// whitelist), so it must be clamped here before reaching the browser: only a known-safe
// model-id shape passes through, anything else drops the field (numeric usage is kept).
// ponytail: shape-whitelist (cap: any well-formed model id like "claude-sonnet-4-6");
// upgrade to an exact model-id set if the HUD ever needs to trust the value semantically.
const SAFE_MODEL_ID = /^[a-z][a-z0-9.-]{0,40}$/;

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

export interface LaneStep {
  /** Server-minted lane slug (planRun) — provenance, never client-derived. */
  slug: string;
  /** Opaque task text for this lane's build agent — never provenance. */
  brief: string;
}

export interface RunPlan {
  runId: string;
  planFile: string;
  model: "haiku" | "sonnet" | "opus";
  lanes: LaneStep[];
}

/**
 * Build the live plan from the SERVER runId. Hash the FULL runId → a fixed-length,
 * validator-safe id so distinct runs never collide on a lane slug / plan file; lane slugs
 * are `lane-<sha16>-<i>` (index-suffixed, all within the registry SLUG cap). The briefs
 * NEVER contribute to a provenance-bearing value — they ride along as opaque task text.
 * ponytail: caller supplies the lane briefs (cap: manual decomposition); real brief → N
 * file-disjoint lanes is the decompose agent's job — a follow-up, out of scope here.
 */
export function planRun(runId: string, routing: Routing, laneBriefs: string[]): RunPlan {
  // Re-assert the route's lane invariants HERE (defense in depth): planRun is the single
  // choke point every lane list passes through, so an internal caller slipping an empty /
  // oversized / junk-entry list fails loudly instead of silently planning a bad run.
  if (!Array.isArray(laneBriefs) || laneBriefs.length < 1 || laneBriefs.length > 4) {
    throw new Error(`laneBriefs must be an array of 1..4 briefs (got ${Array.isArray(laneBriefs) ? laneBriefs.length : typeof laneBriefs})`);
  }
  for (const b of laneBriefs) {
    if (typeof b !== "string" || b.trim() === "") {
      throw new Error("every lane brief must be a non-empty string");
    }
  }
  const id = createHash("sha1").update(runId).digest("hex").slice(0, 16);
  return {
    runId,
    planFile: `plan-${id}.jsonl`, // bare filename
    model: MODEL_BY_ROUTING[routing] ?? "sonnet",
    // `lane-<16 hex>-<i>` = 23 chars for i ≤ 9 — under the 31-char SLUG cap, letter-first.
    lanes: laneBriefs.map((brief, i) => ({ slug: `lane-${id}-${i}`, brief })),
  };
}

// Materialize the route-cost plan.jsonl Gate A (`harness.sh budget`) prices, into the SAME
// contained allow-dir path the bridge passes to budget. One line per lane (budget.py reads
// the batch). Conservative fixed per-lane estimate.
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
  const lines = plan.lanes.map((lane) =>
    JSON.stringify({
      task: lane.slug,
      tier: MODEL_TIER[plan.model],
      in_ktok: 40,
      out_ktok: 8,
      cached_ktok: 30,
      rate_usd_per_mtok: TIER_RATE_USD_PER_MTOK[plan.model],
    })
  );
  // O_CREAT|O_EXCL ("wx"): never overwrite or follow a pre-existing file/symlink at the plan
  // path. The runId is server-random so a fresh run never legitimately collides — an EEXIST
  // here is a signal (a planted file), not a normal condition.
  writeFileSync(abs, lines.join("\n") + "\n", { flag: "wx" });
}

/**
 * How many lane AGENT BUILDS run at once. Only the build step is concurrent — every
 * harness.sh git op stays serial. Default 1 (fully sequential — byte-identical to the
 * single-lane behavior); the operator raises it locally. Concurrent DIRECT-mode lanes are
 * an accepted posture (the agent already runs as the operator with Bash — sibling-worktree
 * readability adds no NEW risk); drop mode keeps per-lane uids (laneUser(i)) and needs the
 * agent-N accounts to exist before raising this on that host. Clamped 1..4. Read per run
 * when the build phase starts (not at module load) so tests and the operator can vary it
 * without a reload.
 */
function laneConcurrency(): number {
  const raw = Number(process.env.LANE_CONCURRENCY);
  const n = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1; // SAFE default: sequential
  return Math.min(4, Math.max(1, n));
}

/**
 * Run `worker` over `items` with at most `cap` in flight at once, preserving each
 * item's index in the result. Settles like Promise.allSettled: one worker rejecting
 * never leaves another's rejection unhandled, and the pool always drains. No new
 * dependency — a tiny index-cursor pool shared by `cap` runners.
 * ponytail: in-process only (no backpressure across processes); fine for one daemon slot.
 */
async function asyncPool<T, R>(
  cap: number,
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const runners = Math.min(Math.max(1, cap), items.length);
  await Promise.all(Array.from({ length: runners }, runner));
  return results;
}

export interface StartRunInput {
  runId: string; // server-generated (route); NEVER client-supplied
  projectId: string;
  projectName: string;
  brief: string;
  routing?: Routing;
  /**
   * Per-lane task briefs (1..4, route-validated). Absent ⇒ a single lane built from
   * `brief`. `brief` itself stays the run's display summary either way.
   */
  laneBriefs?: string[];
}

/** Agent-runner signature (so tests can stub the sandbox without spawning claude). */
export type RunAgentFn = (opts: RunAgentInSandboxOptions) => Promise<RunAgentInSandboxResult>;

// Length-cap the brief before it becomes the agent prompt. Well under agent-runner's
// MAX_PROMPT (100k chars); the composed wrapper below adds only a few hundred chars.
const MAX_BRIEF = 90_000;

/**
 * Compose the headless build agent's prompt from the run brief. The agent runs in DIRECT
 * mode with the FULL toolset (incl. Bash) inside the lane worktree, so the prompt tells it
 * to implement in-place and verify with the project's own tooling — and, crucially, to NOT
 * commit: the harness commits the lane afterwards (wt-commit), and an agent `git commit`
 * would leave nothing for wt-commit to stage → Gate B would misfire. The brief is opaque
 * task text (never provenance) and is length-capped here.
 */
export function buildAgentPrompt(brief: string): string {
  const task = (typeof brief === "string" ? brief : "").slice(0, MAX_BRIEF);
  return [
    "Implement the following task IN THIS WORKTREE (your current working directory).",
    "You have the FULL toolset, including Bash — use it to run the project's own",
    "tests, build, and lint to verify your work as you go.",
    "",
    "TASK:",
    task,
    "",
    "RULES:",
    "- Make all changes inside the current working directory only.",
    "- Verify your work by running the project's own tests/build before finishing.",
    "- DO NOT run `git commit` or `git add`. The harness commits your lane after you",
    "  finish; committing yourself will break the commit/verify step (wt-commit).",
    "Finish once the task is implemented and its tests/build pass.",
  ].join("\n");
}

export interface StartRunOptions {
  /** Force live. Defaults to HARNESS_LIVE === "1". */
  live?: boolean;
  /** TEST-ONLY seam: injectable harness child spawn. IGNORED unless NODE_ENV==="test". */
  spawnFn?: SpawnHarnessOptions["spawnFn"];
  /** TEST-ONLY seam: injectable plan-file writer (avoid real fs). IGNORED unless test. */
  writePlan?: (plan: RunPlan) => void;
  /** TEST-ONLY seam: injectable agent runner (default = real runAgentInSandbox). IGNORED unless test. */
  runAgent?: RunAgentFn;
  /** TEST-ONLY seam: injectable trace relocation (default = real relocateTrace). IGNORED unless test. */
  relocate?: (slug: string, session: string) => boolean;
  /** TEST-ONLY seam: injectable per-lane agent-home cleanup (default = real removeAgentHome). IGNORED unless test. */
  cleanupHome?: (slug: string) => void;
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
  // Real sandbox entrypoint in prod; an injected stub only under the test seam (mirrors
  // spawnFn). The sandbox itself still gates on ENABLE_AGENT_EXEC — this seam is orthogonal.
  const runAgent: RunAgentFn = (testSeam && opts.runAgent) || runAgentInSandbox;
  const relocate = (testSeam && opts.relocate) || relocateTrace;
  const cleanupHome = (testSeam && opts.cleanupHome) || removeAgentHome;

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
    // Hoisted so the `finally` block can reclaim per-lane agent homes for every planned lane.
    let plan: RunPlan | null = null;
    try {
      if (live) {
        // undefined-ONLY fallback: an explicitly-supplied [] (or any bad list) must reach
        // planRun and fail loudly there, not be silently papered over with [brief].
        const laneBriefs = input.laneBriefs === undefined ? [brief] : input.laneBriefs;
        plan = planRun(runId, routing, laneBriefs);
        // Pre-mint ALL provenance up front so a malformed plan fails BEFORE any side effect
        // (no half-created worktrees from a bad later lane).
        mintPlanFile(plan.planFile);
        for (const lane of plan.lanes) mintLane(lane.slug);
        writePlan(plan);

        await runSub({ cmd: "budget", planFile: plan.planFile }); // Gate A
        await runSub({ cmd: "integ-start" });

        // Phase 1 — CREATE WORKTREES: SERIAL, lane order. `git worktree add` mutates the
        // shared index + refs of the single repo, so these can NEVER run concurrently.
        for (const lane of plan.lanes) {
          await runSub({ cmd: "wt-new", slug: lane.slug });
        }

        // Phase 2 — AGENT BUILDS: CONCURRENT, capped at LANE_CONCURRENCY (default 1 —
        // sequential, byte-identical to single-lane). Gated default-OFF behind
        // ENABLE_AGENT_EXEC=1. Each agent EDITS its own worktree in place (per-lane
        // isolated HOME via ensureAgentHome(slug)); the harness commits it below. When
        // the flag is UNSET no agent runs and Gate B honestly raises on the do-nothing
        // worktrees. allSettled semantics (asyncPool) so one lane's rejection never
        // leaves another's unhandled and the pool always drains before we inspect
        // outcomes. If ANY lane failed the WHOLE run fails BEFORE any commit/merge.
        const agentRan = process.env.ENABLE_AGENT_EXEC === "1";
        const model = plan.model; // narrowed capture: `plan` narrowing doesn't cross the worker closure
        let sessions: (string | null)[] = plan.lanes.map(() => null);
        if (agentRan) {
          const builds = await asyncPool(laneConcurrency(), plan.lanes, async (lane, i) => {
            const result = await runAgent({
              prompt: buildAgentPrompt(lane.brief),
              cwd: worktreePathFor(lane.slug),
              sessionId: lane.slug,
              model,
              allowedTools: DEFAULT_TOOLS,
              user: laneUser(i), // drop mode: per-lane uid; direct mode: undefined
            });
            // FAIL CLOSED on a nonzero agent exit: runAgentInSandbox only REJECTS on
            // timeout/gate-refusal — a clean process exit with a nonzero code RESOLVES
            // normally. A failed agent must NOT flow into wt-commit/verify/merge, so
            // throw here (the pool records it as this lane's rejection).
            if (result.exitCode !== 0) {
              throw new Error(`agent exited nonzero (code ${result.exitCode}) — failing run before wt-commit`);
            }
            // Surface ACTUAL usage/cost/context (HUD gauges) when the agent reported it.
            // The child-controlled `model` string bypasses the harness stdout schema, so
            // clamp it to a known-safe shape (else drop the field); numeric usage kept.
            if (result.usage) {
              const { model, ...numeric } = result.usage;
              const safeModel = typeof model === "string" && SAFE_MODEL_ID.test(model) ? { model } : {};
              ingest(toEnvelope({ type: "usage", laneId: lane.slug, ...safeModel, ...numeric }));
            }
            return result.sessionId;
          });
          const failed = builds.findIndex((b) => b.status === "rejected");
          if (failed !== -1) {
            const reason = (builds[failed] as PromiseRejectedResult).reason;
            throw new HarnessExitError(
              `agent for lane '${plan.lanes[failed].slug}' failed: ${reason instanceof Error ? reason.message : String(reason)}`
            );
          }
          sessions = builds.map((b) => (b as PromiseFulfilledResult<string | null>).value);
          // Cross-lane session-id uniqueness (fail closed, BEFORE any commit): sessions are
          // agent-reported values, and a lane echoing a sibling's session id could clobber
          // the sibling's relocated trace or ride its Gate D result. Distinct-or-die.
          const nonNull = sessions.filter((s): s is string => s !== null);
          if (new Set(nonNull).size !== nonNull.length) {
            throw new HarnessExitError("duplicate agent session ids across lanes — failing run closed before wt-commit");
          }
        }

        // Phase 3 — FINALIZE ALL LANES: SERIAL, lane order. wt-commit → wt-verify (Gate B)
        // → Gate D for EVERY lane BEFORE any merge: if a later lane fails its gates here,
        // no earlier lane has been merged yet, so integration is never left partially
        // merged by a doomed run (mirrors the web/ reference daemon's phase split).
        for (let i = 0; i < plan.lanes.length; i++) {
          const lane = plan.lanes[i];
          await runSub({ cmd: "wt-commit", slug: lane.slug });
          await runSub({ cmd: "wt-verify", slug: lane.slug }); // Gate B

          // Gate D (trace) — AFTER Gate B, BEFORE this lane's merge: a looping/thrashing
          // agent's lane must not reach integration. FAIL CLOSED when the agent RAN: a
          // valid session, a successful relocate, AND the trace subcommand are ALL
          // mandatory. An agent must not be able to evade the loop/thrash check by
          // suppressing/deleting its trace (a missing session or a false relocate would
          // otherwise silently skip Gate D and still merge). Safe: an agent that made
          // zero edits already failed at wt-commit ("nothing to commit") above, so
          // requiring a trace once the agent ran cannot false-positive.
          if (agentRan) {
            const agentSessionId = sessions[i];
            if (!agentSessionId) {
              console.error(`[daemon] run ${runId} Gate D fail-closed: agent for lane ${lane.slug} produced no valid session id`);
              throw new Error(`agent for lane ${lane.slug} produced no valid session id — failing run closed (Gate D cannot be skipped)`);
            }
            mintSession(agentSessionId);
            if (!relocate(lane.slug, agentSessionId)) {
              console.error(`[daemon] run ${runId} Gate D fail-closed: agent trace could not be relocated for lane ${lane.slug}`);
              throw new Error(`agent ran but its trace could not be relocated (lane ${lane.slug}) — failing run closed (Gate D)`);
            }
            await runSub({ cmd: "trace", session: agentSessionId }); // Gate D
          }
        }

        // Phase 4 — MERGE ALL LANES: SERIAL, lane order, only after EVERY lane passed
        // Gates B+D. Gate C: the FIRST conflicting integ-merge exits non-zero → runSub
        // throws → the run fails closed with that lane's gate raised. Conflicts between
        // non-disjoint lanes surface as normal git conflicts, never auto-resolved.
        for (const lane of plan.lanes) {
          await runSub({ cmd: "integ-merge", slug: lane.slug });
        }
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
        // Reclaim per-lane isolated agent HOMEs (credential copies under the agent-homes
        // base) for EVERY planned lane — run-unique slugs would otherwise sprawl one
        // credential copy per lane per run. Best-effort per lane (removeAgentHome is a
        // no-op when the home was never provisioned); never skips the slot release.
        for (const lane of plan?.lanes ?? []) {
          try {
            cleanupHome(lane.slug);
          } catch (e) {
            console.error(
              `[daemon] run ${runId} agent-home cleanup failed for lane ${lane.slug}:`,
              e instanceof Error ? e.message : String(e)
            );
          }
        }
      }
      releaseSlot(runId);
    }
  })();
}
