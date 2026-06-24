# ADR 0001 — Umbrella Web UI: module boundaries, the scene data-model contract, and the 3-lane parallel-build decomposition

- Status: Accepted — reconciled with NOTES.md (disjoint store ownership, §3/§2.4 below); the Lane 0 scaffold commit is the act of approval. Phase 3 (`parallel-build`) follows.
- Date: 2026-06-23
- Deciders: architect (this ADR), folding in web-design, frontend, security-engineer perspectives inline.
- Supersedes / depends on: nothing. Consumed by: `parallel-build`.

---

## 1. Context

**Umbrella** is the dark, futuristic, keyboard-first 3D holographic control panel that wraps the HARNESS four-phase agent build pipeline — a private, Tailscale-only power tool for one expert operator. A single task flows top→bottom through the six harness stages (decompose → parallel build → route-cost → cross-review → sequential merge → eval-gate → promote), rendered as a living r3f node-graph over a glass shadcn HUD, driven by an SSE stream off the daemon that orchestrates `harness.sh`. Every visual, UX, token, and motion decision is already **LOCKED** by the committee package at [`docs/umbrella-ui-design-package.md`](../umbrella-ui-design-package.md) (brief, plan, 15 decisions, 32 tasks, 17-row risk register, 5-phase roadmap) and the locked-decisions plan at `~/.claude/plans/find-the-most-recent-sequential-wigderson.md`. This ADR does **not** re-open any of decisions 1–15. Its only job is to translate the locked system into module/component boundaries, per-file ownership, and a parallel-build decomposition that three concurrent worktree lanes can build against without semantic drift. The load-bearing deliverable — per decision 15 and roadmap Phase 0 — is the **scene data-model contract** frozen in §2 below.

---

## 2. The scene data-model contract (load-bearing)

This is the shared seam all three lanes build against. It is frozen here, before decomposition. Everything else in this ADR is downstream of it. It encodes decisions 8, 11, 15 and risk rows 2, 11, 17.

### 2.1 The two-renderer rule (the invariant that makes parallelism safe)

There is exactly **one** source of truth on the client: a normalized `RunState` store, reduced from the SSE stream. Both rendered surfaces are **pure projections** of it:

```
                        ┌────────────────────────────┐
   SSE (lane A) ──────▶ │  reducer  →  RunState store │
                        └──────────────┬─────────────┘
                                       │  one rAF-aligned flush per frame
                          ┌────────────┴────────────┐
                          ▼                          ▼
              scene = project(RunState)   dom = project(RunState)
                  (lane B, r3f)              (lane C, semantic-DOM mirror)
```

**Hard rule:** `project_scene(RunState) → scene-graph` and `project_dom(RunState) → semantic HTML + aria-live`. The scene **never** reads the DOM; the DOM **never** reads the scene. The only legal write path into either projection is the store. Drift between the holographic view and the accessible view is therefore structurally impossible (risk 11). Neither lane B nor lane C is allowed to hold derived authoritative state — any cross-surface fact (e.g. "gate detail is open", which gates the Gate-D auto-surface in §4c) lives **in the store** as UI state, not in a component.

### 2.2 The typed store shape

`RunState` is the reduced projection of the whole run. Times are epoch-seconds (matching the trace `ts` field). All ids are stable strings.

```ts
// Owned by lane A as the contract source; imported (not redefined) by lanes B and C.
// ponytail: a single run. Multi-run history persists server-side only — no client array, no history UI in v1.

type PhaseId = 1 | 2 | 3 | 4 | 5 | 6; // decompose · build · route-cost · cross-review · merge · eval+promote
type SubtaskStatus = "pending" | "building" | "reviewed" | "merged" | "blocked";
type GateId = "A" | "B" | "C" | "D";  // A budget · B review-block · C integration-red · D anomaly
type Severity = "info" | "low" | "medium" | "high" | "critical";

interface Subtask {
  id: string;            // e.g. "st-1"
  title: string;         // Space Grotesk node label (lane B only)
  status: SubtaskStatus;
  phase: PhaseId;        // where this subtask currently sits
  ownerFiles: string[];  // file-ownership from NOTES.md decomposition
  model?: "haiku" | "sonnet" | "opus"; // route-cost decision, once made
}

interface PhaseState {
  id: PhaseId;
  label: string;
  status: "idle" | "active" | "done" | "blocked";
  // Two phases carry an inline human-judgment approval (decision 4), modeled as store state:
  approval?: { kind: "decompose-split" | "promote-to-main"; state: "awaiting" | "approved" | "rejected" };
}

interface Gate {
  id: GateId;
  status: "clear" | "raised" | "resolved";
  severity: Severity;
  subtaskId?: string;        // which subtask tripped it
  counts?: { high: number; critical: number }; // for the inbox severity count
  summary: string;           // the one-line "what" for the inbox triage line
  raisedAt?: number;
  // Gate D only: trace readiness, gated by the "sacred detail" rule (§4c, decision 5)
  traceReady?: boolean;
}

interface AgentEvent {        // an agent-fire: a transient burst, not durable state
  id: string;
  subtaskId: string;
  kind: "route" | "review" | "gate" | "merge" | "promote";
  severity: Severity;         // drives co-fire stagger ordering + burst hue
  firedAt: number;            // burst peak time; flush layer derives attack/bloom phase
}

interface TraceTick {         // {ts, tool, sig} — streams to the DRAWER ONLY (risk 17)
  ts: number;
  tool: string;
  sig: string;
  subtaskId?: string;
}

interface Budget {
  ceilingUsd: number;
  estimatedUsd: number;       // from budget.py
  spentUsd?: number;
  overBy?: number;            // > 0 ⇒ Gate A territory
}

interface RunState {
  task: { id: string; brief: string; phase: PhaseId; state: "idle" | "running" | "done" | "failed" };
  subtasks: Subtask[];
  phases: PhaseState[];               // the six-phase rail
  gates: Gate[];                       // A–D, persistent inbox source
  agentEvents: AgentEvent[];           // recent bursts; pruned after bloom-decay window
  trace: TraceTick[];                  // drawer feed, capped/windowed by lane C
  budget: Budget;
  ui: {                                // cross-surface UI state lives in the store, not in components
    openDetail: { kind: "gate" | "phase" | null; id: string | null };
    pendingToast?: { gate: GateId; message: string }; // §4c non-blocking toast-on-close
  };
}
```

### 2.3 The SSE event schema (lane A produces, lanes B & C consume)

One discriminated union over `type`. The reducer is total over this union; any unknown `type` is dropped (forward-compat). Each variant is the minimal delta needed to update `RunState`.

```ts
// Owned by lane A; the wire contract. Lanes B/C import the type and the reducer signature only.
type SSEEvent =
  | { type: "phase";    phase: PhaseId; status: PhaseState["status"] }
  | { type: "subtask";  id: string; status: SubtaskStatus; phase?: PhaseId; model?: Subtask["model"] }
  | { type: "gate";     id: GateId; status: Gate["status"]; severity: Severity;
                        subtaskId?: string; counts?: Gate["counts"]; summary: string; traceReady?: boolean }
  | { type: "agentFire"; id: string; subtaskId: string; kind: AgentEvent["kind"]; severity: Severity; firedAt: number }
  | { type: "trace";    ts: number; tool: string; sig: string; subtaskId?: string }
  | { type: "budget";   ceilingUsd: number; estimatedUsd: number; spentUsd?: number; overBy?: number }
  | { type: "approval"; phase: PhaseId; kind: PhaseState["approval"]["kind"]; state: "awaiting" | "approved" | "rejected" }
  | { type: "hello";    run: RunState }; // full snapshot on connect / reconnect resync
```

Control flows the other way over plain HTTP (not SSE): inline approvals (decompose-split phase ①, promote-to-main phase ⑥) and gate adjudications POST to the control-plane API (§4a), which acts on `harness.sh` and emits the resulting `phase`/`gate`/`approval` events back down the stream. The browser never drives git or models directly.

### 2.4 The rAF-aligned batch/flush window (decision 15 + risk 2)

The raw SSE stream is **not** wired into React reconciliation per event. Events land in the reducer and mutate a working copy; **exactly one flush per animation frame** publishes the new `RunState` to both projections. This is the named contract member, owned alongside the store:

- SSE handler → `reducer.apply(event)` accumulates deltas into a pending buffer (no React notify).
- A single `requestAnimationFrame` loop calls `store.flush()` once per frame: commits the buffer, bumps the store version, notifies subscribers (React via `useSyncExternalStore`; r3f via a frame-loop read).
- At a Gate B + Gate D co-fire burst, N events collapse into **one** reconciliation pass per frame instead of N — this is the structural fix for dropped frames (risk 2), and it is cheap to specify now and hard to retrofit later, which is why it is frozen in the contract rather than left to a lane.
- The flush is the single clock both projections share, so the co-fire stagger (decision: 80–120ms severity-ordered) is computed from `firedAt` deltas at flush time, not from event arrival jitter.

`store.flush()` and the `useSyncExternalStore` subscription are part of the contract surface. Ownership is **disjoint** (reconciled with NOTES.md): the store *interface* lives in `lib/contract/store.ts` (lane A, type-only, imported by all); the store *implementation* (`store.ts`, `raf-flush.ts`) is lane B's, sole writer; the React binding (`useRunState.ts`) is lane C's. No file is co-written. See §3 for the full ownership split.

---

## 3. Module / component boundaries + per-file ownership

App lives in a new `web/` subtree at repo root (kept out of `.claude/`, which stays harness-skill territory). Next.js App Router. One line of ownership per path; the lane letter is the owning worktree.

```
web/
  app/
    layout.tsx                      (C) RSC root: fonts, theme, <html>, mounts shells
    page.tsx                        (C) RSC: idle submit surface ⇄ running pipeline (two states, one screen — decision 2)
    api/
      runs/route.ts                 (A) POST start run, GET snapshot; control-plane entry
      runs/[id]/stream/route.ts     (A) GET SSE endpoint — emits SSEEvent stream
      runs/[id]/approve/route.ts    (A) POST inline approvals (decompose-split, promote-to-main)
      runs/[id]/gate/route.ts       (A) POST gate adjudications (raise ceiling / override / resolve)
    globals.css                     (C) Tailwind base + token CSS vars (see §web-design map)
  lib/
    contract/
      types.ts                      (A) RunState, Subtask, Gate, AgentEvent, TraceTick, Budget, PhaseState  ← FROZEN §2.2
      events.ts                     (A) SSEEvent union + reducer(state, event): RunState  ← FROZEN §2.3
      README.md                     (A) the seam doc; lanes B/C import from here, never redefine
    daemon/
      daemon.ts                     (A) single-slot orchestrator: spawns/sequences harness.sh, parses stdout → SSEEvent
      harness-bridge.ts             (A) maps harness.sh subcommands (budget/wt-new/integ-*/trace/promote) → events
      persist.ts                    (A) write run outcome/cost/gate events to DB (no read UI in v1)
    store/
      store.ts                      (B) createStore, getSnapshot, subscribe, flush — implements lib/contract/store.ts
      raf-flush.ts                  (B) the one-flush-per-frame loop (§2.4)
      useRunState.ts                (C) useSyncExternalStore React binding (imports the interface from contract)
    sse/
      client.ts                     (C) EventSource client → reducer.apply; reconnect/hello resync
  scene/                            (B) — pure projection of RunState; reads store, never the DOM
    Canvas.tsx                      (B) the single <Canvas> mount point (client component)
    sceneGraph.ts                   (B) project_scene(RunState) → node/edge/burst descriptors
    AmbientField.tsx                (B) instanced-only graphify backdrop, ≤~2k nodes, LOD/cull
    NodeGraph.tsx                   (B) foreground 15–40 live nodes + edges (task core, orbiting subtasks)
    AgentFire.tsx                   (B) burst motion: <120ms attack → 400–600ms bloom/decay; co-fire stagger
    Bloom.tsx                       (B) post-process bloom; enforces max-bloom-radius + min-node-radius floor
    motion.ts                       (B) scene motion tokens (sine breathing, energy ramp, spring settle)
    perf.ts                         (B) draw-call budget guard, instancing, LOD thresholds, frameloop policy
  hud/                              (C) — pure projection of RunState; reads store, never the scene
    HudShell.tsx                    (C) glass layer over the canvas; layout of rail/rail-detail/drawer
    PhaseRail.tsx                   (C) the six-phase vertical pipeline rail (28px idle rows)
    InboxRail.tsx                   (C) authoritative gate triage line; glass + motion-suppressed region
    GateDetail.tsx                  (C) on-demand dense mono evidence panel; sets ui.openDetail
    ApprovalStep.tsx                (C) inline decompose-split (①) + promote-to-main (⑥) approvals
    CommandPalette.tsx              (C) ⌘K via cmdk
    TraceDrawer.tsx                 (C) ▸ drill-down; {ts,tool,sig} rows (mono, tabular); Gate-D feed
    Toast.tsx                       (C) non-blocking "Gate D trace ready — view?" chip (§4c)
    a11y/
      DomMirror.tsx                 (C) project_dom(RunState) → semantic HTML mirror of the scene
      LiveRegion.tsx                (C) aria-live announcer: phase changes, gate escalations, agent fires
      announce.ts                   (C) announcement copy patterns + non-color badge/label pairing
  ui/                               (C) shadcn/ui primitives (generated; glass variants)
  styles/
    tokens.css                      (C) the single token source-of-truth (color/type/space/motion vars)
    tailwind.config.ts              (C) maps tokens → Tailwind theme
```

`lib/contract/` is the frozen seam (lane A authors it), and it now includes `store.ts` (the store *interface*, type-only) so every lane compiles independently against it. The store *implementation* (`lib/store/store.ts` + `raf-flush.ts`) is **lane B's, single-writer**; lane C writes only its binding (`useRunState.ts`), importing the interface from contract, never B's internals. Write-ownership is therefore fully disjoint — this is the resolution carried in NOTES.md and is what lets `parallel-build` start without refusing on a shared-file conflict.

---

## 4. The 3-lane decomposition for `parallel-build`

Three worktrees, decomposed by file ownership above so the lanes cannot semantically collide. **Lane A produces** the contract (it authors `lib/contract/`); **lanes B and C consume** it (import-only, never redefine). The contract in §2 is the precondition — it must be frozen (it is, here) before any lane starts.

### Lane A — daemon + control-plane API (PRODUCES the contract)
Owns: `web/app/api/**`, `web/lib/contract/**`, `web/lib/daemon/**`, `web/lib/store/persist.ts`.
- Drives `harness.sh` as a strict single-slot orchestrator: `budget` (Gate A), `wt-new`, `integ-start`, `integ-merge` (Gate C on conflict), `trace` (Gate D), `promote`. Parses each subcommand's output into `SSEEvent`s. Maps `budget.py` output → `budget` events; `trace-check.py` LOOP/EXPLOSION/THRASH → Gate D `gate` events; cross-review BLOCK → Gate B; merge conflict → Gate C.
- Emits the SSE stream (`runs/[id]/stream`) and accepts control POSTs (`approve`, `gate`). Sends a `hello` full-snapshot on connect/reconnect.
- Persists run outcome/cost/gate events to DB (no read UI in v1).
- **security-engineer (trust boundary):** Lane A is the *only* tier that holds credentials. Per `lib/sdk.ts`, `ANTHROPIC_API_KEY` is deleted to force the Max-plan subscription — no API spend, no API key in the process env to leak. The browser never sees any credential: it speaks only to lane A's HTTP/SSE endpoints, and lane A speaks to the Claude Agent SDK and to git/`harness.sh`. The whole surface is reachable only over the private Tailscale network; there is no public ingress and v1 ships no in-app authn (network *is* the perimeter). Control endpoints (`approve`, `gate`, `runs` POST) mutate git state and spend the Max plan's effective quota, so they MUST validate inputs at this boundary (run-id ownership, single-slot lock, approval-kind/phase match) and MUST reject any client-supplied file paths, branch names, or shell fragments — `harness-bridge.ts` constructs all `harness.sh` arguments server-side from validated enums, never by passing client strings through. Hand off a full threat model to `security-engineer` before Phase 3: the assets are the Max-plan session and the operator's repo/main branch; the inline `promote-to-main` approval is the highest-value control to protect.

### Lane B — r3f 3D scene (CONSUMES the contract)
Owns: `web/scene/**`.
- `project_scene(RunState)` → scene graph: task core node, orbiting subtask nodes (Space Grotesk labels only — decision: node-labels-only), pulsing edges. No HUD chrome ever renders here.
- Ambient generative backdrop = the graphify-out world as a **single instanced draw call**, ≤~2k nodes, near-static, aggressive LOD/cull (decision + risk 3). Foreground = 15–40 live nodes at full detail. 60fps target; `perf.ts` owns the draw-call ceiling (exact integer tuned in build profiling).
- Agent-fire motion: sharp <120ms attack → organic 400–600ms bloom/decay, restrained-spring node settle (no elastic), 80–120ms severity-ordered co-fire stagger derived from `firedAt` at flush time, 1.2–1.8s backdrop energy ramp.
- `Bloom.tsx` enforces **max-bloom-radius + min-node-radius floor**; below the floor, bursts degrade to static rings (decision + risk 4: prevents violet ~274° / cyan ~208° collision under bloom).
- Reads the store via `raf-flush` inside the r3f frame loop; never reads the DOM.
- **frontend:** the single `<Canvas>` (`Canvas.tsx`) is a client component mounted once inside the running-state branch of `page.tsx`; everything under `scene/` is client. r3f drives its own render loop and reads `getSnapshot()` per frame, so scene updates bypass React reconciliation entirely — only the rAF flush bumps the version it watches.

### Lane C — glass shadcn HUD + semantic-DOM mirror (CONSUMES the contract)
Owns: `web/hud/**`, `web/app/layout.tsx`, `web/app/page.tsx`, `web/app/globals.css`, `web/lib/store/{store.ts,raf-flush.ts,useRunState.ts}`, `web/lib/sse/client.ts`, `web/ui/**`, `web/styles/**`.
- Gate-inbox rail = the single authoritative triage line carrying the four required facts (requires-you / which subtask / severity count / one-line what); glass material with **WebGL particle motion suppressed behind its region** (decision + risk 6) as the attentional anchor.
- ⌘K command palette (cmdk); inline approvals as pipeline steps — decompose-split (phase ①) and promote-to-main (phase ⑥); trace drawer (`▸`) showing `{ts,tool,sig}` mono/tabular rows — trace never enters the scene graph (risk 17).
- **"Open detail context is sacred" (decision 5):** Gate D auto-opens the trace drawer ONLY when `ui.openDetail` is null; otherwise it demotes to a loud, distinctly-styled inbox item + graph flare, severity-ordered ("2 gates need you"). On detail close, if a Gate-D trace is pending, show the non-blocking `Toast.tsx` chip ("Gate D trace ready — view?") — operator-initiated, no hijack.
- Semantic-DOM mirror (`a11y/DomMirror.tsx`) = `project_dom(RunState)` real HTML; `LiveRegion.tsx` aria-live announces phase changes, gate escalations, agent fires; every color-snap is paired with a persistent non-color badge/label (WCAG 1.4.1). Motion-lite under `prefers-reduced-motion` is honored in `motion.ts` (lane B) for the scene and in HUD transitions here.
- **frontend:** `layout.tsx` and `page.tsx` are RSC (fonts, theme, shell, the idle submit surface). The running pipeline, the canvas, the HUD, and the SSE client are all **client** components below the first interactive boundary. `lib/sse/client.ts` opens the `EventSource`, feeds `reducer.apply`, and never notifies React directly — the rAF flush is the only notifier. React subscribes via `useSyncExternalStore` (`useRunState.ts`), so HUD re-renders are frame-batched and cannot fight the r3f loop.

### Sequential merge order (through the integration branch)
1. **Lane A** first — it authors the frozen contract (`lib/contract/`) every other lane imports; nothing compiles without it. Includes the store *interface* stub.
2. **Lane B** second — first real consumer of the store; lands `store.ts`/`raf-flush.ts` internals against the frozen interface, proves the scene projection + perf ceilings on real events.
3. **Lane C** last — consumes the same store via `useRunState.ts`, lands the HUD + DOM mirror + a11y. Merging last lets the accessibility mirror and inbox be validated against an already-working scene and event stream.

Each lane is gated by a `cross-review` PASS before its `--no-ff` merge into integration; `eval-gate` runs on integration before fast-forward to main (the harness building its own UI).

### web-design — locked-token map (cite-and-assign, no redesign)
| Token (LOCKED) | Where applied | Lane |
|---|---|---|
| Base surface HSL 222 11% 6% | `styles/tokens.css` `--bg`; canvas clear color | C (def) / B (clear) |
| Five-stop indigo→violet accent (dim-fill→rest-glow→mid→vivid→neon, ~258°→~274°) | glass tint + ring/border + ⌘K = C; emissive burst (neon, violet) = B | C + B |
| 4 status hues × 2 tokens (emerald/teal ~150°, cyan ~208°, amber ~46–48°, scarce red; fill/glow + +6–8% text bump) | inbox/phase rows, badges, mono text = C; node burst hue = B | C + B |
| Geist Sans 13px (UI) / Geist Mono 12px tabular-lining (data) | all HUD chrome, trace/cost/ID columns | C |
| Space Grotesk — large 3D node labels ONLY | node titles in `NodeGraph.tsx`; must not leak to HUD | B |
| 4px grid (4/8/12/16/24/32); rows 28px idle → 32–36px active | HUD spacing, rail rows; node sizing derives off 4px unit | C (HUD) / B (nodes) |
| Glass opacity-floor token (back-solved from neon-burst worst-case luminance) | every glass panel background-alpha; guarantees ≥4.5:1 under peak bloom (risk 1) | C |
| Max-bloom-radius + min-node-radius floor | `Bloom.tsx` post-process clamps | B |
| Motion tokens (1.2–1.8s backdrop ramp, 80–120ms co-fire stagger, <120ms attack/400–600ms bloom, 600–900ms sine, restrained spring) | scene motion = `motion.ts` (B); <200ms ease-out foreground = HUD transitions (C) | B + C |

---

## 5. Consequences + alternatives considered

### Consequences
- **Positive.** The frozen contract (§2) makes the three lanes genuinely independent: B and C share zero mutable state, only the typed seam, so semantic conflict is confined to ordinary git merges at the integration branch. The two-renderer rule makes scene/DOM drift structurally impossible (risk 11) and gives AT parity for free as a design property, not a bolt-on (risk 9). The rAF flush is the single fix that addresses the worst perf risk (row 2) at the architecture level rather than per-component. Credentials never cross the network boundary; the browser is a pure projection of server-held truth.
- **Costs / accepted ceilings.** `ponytail:` one run in the store, no client history array — multi-run history is server-DB-only in v1; upgrade path is a `runs[]` slice + a history route when a history UI is wanted. `ponytail:` `lib/store/store.ts` is a small shared-interface seam co-owned by B and C; if it grows, split read-binding from flush. The exact draw-call integer and the precise glass opacity-floor alpha are left to build profiling within the named ceilings — deliberate, per the locked decisions. Single-slot daemon means no concurrent runs in v1 (inherited constraint, not re-opened).
- **Follow-ups before Phase 3.** Threat model from `security-engineer` on the control endpoints + promote-to-main. `database` skill for the run-persistence schema (`persist.ts`). `devops` for the Tailscale-only deploy + single-slot process supervision.

### Alternatives considered
- **One renderer (DOM-driven scene or scene-driven DOM) instead of two pure projections.** Rejected: any direction of cross-read reintroduces drift and couples the a11y mirror to WebGL internals; the locked decision 15 already settled this and the cost of two pure projections (a little duplicate projection code) is far cheaper than a sync bug class that only AT users hit.
- **Per-event React updates (no rAF batch).** Rejected: it is the documented cause of dropped frames at Gate B+D co-fire (risk 2) and is structurally hard to retrofit after decomposition — cheap to mandate now.
- **Decompose by surface/feature (submit / board / gates / trace) instead of by tier (daemon / scene / HUD).** Rejected: feature decomposition cross-cuts the store, the canvas, and the API, so every lane would touch every file — the opposite of clean ownership. Tier decomposition aligns the worktree boundaries with the §3 file ownership and the produce/consume direction of the contract.
- **A desktop transparency shell / native window for the "blend with environment" effect.** Rejected by decision 10 (pure web ambient backdrop); noted only to record it stays closed.
- **Putting the trace stream into the 3D graph.** Rejected: hundreds of `{ts,tool,sig}` ticks would choke the scene (risk 17); trace is drawer-only by contract (`trace` events flow to `RunState.trace`, consumed only by `TraceDrawer.tsx`).

---

**This ADR stops here for review before Phase 3 (`parallel-build`).** On approval, `parallel-build` decomposes into the three worktrees in §4, merged sequentially A → B → C through the integration branch, each gated by `cross-review`, then `eval-gate` before main.
