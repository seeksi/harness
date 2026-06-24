# NOTES.md — Phase 3 decomposition (parallel-build) for the Umbrella Web UI

Orchestrator-owned. Derived from [`docs/adr/0001-umbrella-ui-design.md`](docs/adr/0001-umbrella-ui-design.md).
This is the spec `parallel-build` consumes: 3 lanes, **disjoint write-ownership**,
each with a one-line spec + acceptance check. Status: **LOCKED** (reconciled with
ADR 0001, which is now Accepted; store ownership is disjoint in both docs). Built
in increments: **Lane 0 (shared scaffold + frozen contract) lands first on main**,
then `wt-new` cuts the A/B/C worktrees.

## Precondition (must be true before any lane starts)
- The scene data-model contract (ADR §2) is **frozen**: `RunState`, the `SSEEvent`
  union, the two-renderer rule, the rAF flush window. Lane A authors it first
  (it is the only shared, imported-by-all surface); B and C **import-only**.
- App lives under a new `web/` subtree at repo root; `.claude/` is untouched.

## Ownership-conflict resolution (vs the ADR's co-owned seam)
The ADR co-owned `lib/store/store.ts` + `raf-flush.ts` between B and C. That
violates parallel-build's hard rule (no two subtasks may write the same file) and
would also stop the lanes compiling independently. **Resolution:**
- **Store *interface*** (`createStore/getSnapshot/subscribe/flush` signatures +
  `useSyncExternalStore` contract) → `web/lib/contract/store.ts`, authored by
  **Lane A** (type-only). Everyone imports this.
- **Store *implementation*** (`store.ts`, `raf-flush.ts`) → **Lane B**, sole writer.
- **React binding** (`useRunState.ts`) → **Lane C**, sole writer; imports the
  interface from contract, not B's internals.

Result: write-ownership is fully disjoint; cross-lane references are import-only
against the frozen contract.

---

## Lane 0 — shared scaffold + frozen contract  (lands first on main, BEFORE `wt-new`)
Decided by the council + dev-team deliberation. Lane 0 is **scaffold and signatures
only — zero behavior**. Rule: if a lane could legitimately disagree about it at
merge, it belongs in Lane 0; if it's a real implementation choice, it stays in a lane.

**Lands on main:**
- `web/` Next.js App Router skeleton that builds green: `package.json` with **pinned**
  versions (Next/React/react-three-fiber/three/drei/tailwind/shadcn-cli), `tsconfig.json`
  with `@/*` path map, `next.config`, rendering `app/layout.tsx` + `app/page.tsx`,
  `globals.css` declaring token CSS-var names (empty values OK).
- `web/lib/contract/**` in full — the ADR §2 freeze made real:
  `types.ts` (RunState et al), `events.ts` (SSEEvent union + `reducer(state,event):RunState`
  **signature**, body stub throws), `store.ts` (store *interface* only), `README.md`,
  and `fixture.ts` — the canonical deterministic `SSEEvent[]` transcript (hello → phases →
  subtasks → a **Gate B+D co-fire burst** → approval → promote-preview), promoted to a
  contract artifact so B and C build against the same bytes. Add a `TRACE_WINDOW` constant
  (ring-buffer cap) so B's store and C's drawer agree on the trace bound.
- Import-boundary eslint (`no-restricted-imports` / `import/no-restricted-paths`):
  `scene/**` ✗ `hud/**`; `hud/**` ✗ `scene/**`; both import the store ONLY via
  `lib/contract/**`; `lib/store/**` importable only by `scene/**` + `lib/store/useRunState.ts`.
- `CODEOWNERS` encoding the §3/§4 per-lane ownership.

**Runtime/process decisions baked in now (devops — cannot be retrofitted):**
- `export const runtime = "nodejs"` on every `app/api/**` route (spawns harness.sh; uses better-sqlite3).
- The daemon lives **inside** the Next.js Node server (module imported by routes), not a sidecar.
- SSE `hello` snapshot is the **only** resync path — server emits it on every (re)connect.
- DB = SQLite (WAL, `better-sqlite3`, no ORM): `runs` (snapshot) + `events` (append-only)
  + single-row `slot` table for the atomic single-slot lock.

**Security minimums baked into the contract/skeleton now (security-engineer, B1–B7):**
server-side enum-only harness.sh args (never client strings → paths/branches/slugs);
server-generated run IDs; strict JSON-only validation; single-slot lock as a server
invariant; CSRF same-origin + custom-header guard, no CORS; **promote is preview-only**
(non-mutating) behind a flag the full threat model flips. Highest risk to anchor review:
**CSRF-driven promote-to-main**.

**First build increment after Lane 0 = "State Spine + Dry Run"** (qa-lead's 21-check gate):
fake-rAF burst (100 events/frame → exactly 1 notify) is the single highest-value test;
reducer total + drops unknown + `subtask` delta merges (not replaces) + `hello` wholesale
replaces; `POST /runs` 2nd → 409; stream emits hello then scripted events; promote stubbed.

---

## Lane A — daemon + control-plane API  (PRODUCES the contract)
**Spec:** Author the frozen contract, then a strict single-slot daemon that drives
`harness.sh`, parses each subcommand's output into `SSEEvent`s, emits the SSE
stream, accepts control POSTs, and persists run outcomes. Sole credential holder.

**Owns (write):**
- `web/lib/contract/**` — `types.ts` (RunState et al, ADR §2.2), `events.ts`
  (SSEEvent union + reducer signature, §2.3), `store.ts` (store *interface* only),
  `README.md` (the seam doc).
- `web/lib/daemon/**` — `daemon.ts` (single-slot orchestrator), `harness-bridge.ts`
  (maps `harness.sh budget|wt-new|integ-start|integ-merge|trace|promote` → events).
- `web/app/api/**` — `runs/route.ts` (start/snapshot), `runs/[id]/stream/route.ts`
  (SSE), `runs/[id]/approve/route.ts` (① decompose-split, ⑥ promote-to-main),
  `runs/[id]/gate/route.ts` (raise ceiling / override / resolve).
- `web/lib/store/persist.ts` — write outcome/cost/gate events to DB (no read UI v1).

**Security (trust boundary, from ADR §4a):** only tier holding credentials;
`ANTHROPIC_API_KEY` deleted to force Max-plan (`lib/sdk.ts`); Tailscale-only, no
public ingress, no in-app authn in v1. Control endpoints validate run-id/single-slot
lock/approval-kind, and build all `harness.sh` args server-side from validated
enums — **never** pass client strings as paths/branches/shell fragments.

**Acceptance check:**
- `tsc` clean on `lib/contract/**` (the seam everyone imports).
- Unit: each `harness.sh` subcommand's sample output → expected `SSEEvent` (budget→Gate A, BLOCK→Gate B, merge-conflict→Gate C, trace LOOP/EXPLOSION/THRASH→Gate D).
- Integration: `POST /runs` starts a slot; a second concurrent start is rejected; SSE emits `hello` snapshot on connect; `approve`/`gate` rejects malformed input.
- No credential reachable from any response body or client-facing route.

**Suggested model (route-cost):** Sonnet (contract design already done in the ADR; this is spec-driven plumbing).

---

## Lane B — r3f 3D scene  (CONSUMES the contract)
**Spec:** Implement the store internals + the scene as a pure projection of
`RunState`: instanced graphify backdrop, foreground node-graph, agent-fire motion,
bloom with the emissive-safety floors. Reads the store in the frame loop; never
reads the DOM.

**Owns (write):**
- `web/lib/store/store.ts`, `web/lib/store/raf-flush.ts` — implement the contract
  interface; one `flush()` per `requestAnimationFrame`, no per-event React notify.
- `web/scene/**` — `Canvas.tsx` (single `<Canvas>` client mount), `sceneGraph.ts`
  (`project_scene(RunState)`), `AmbientField.tsx` (instanced-only graphify world,
  ≤~2k nodes, LOD/cull), `NodeGraph.tsx` (15–40 live nodes; Space Grotesk labels
  ONLY), `AgentFire.tsx` (<120ms attack → 400–600ms bloom; 80–120ms severity
  co-fire stagger from `firedAt`), `Bloom.tsx` (max-bloom-radius + min-node-radius
  floor; degrade to static rings below floor), `motion.ts` (sine breathing,
  1.2–1.8s energy ramp, restrained spring; motion-lite under reduced-motion),
  `perf.ts` (draw-call ceiling, instancing, frameloop policy).

**Acceptance check:**
- `store.ts`/`raf-flush.ts` satisfy the contract interface (`tsc` against `lib/contract/store.ts`); a burst of N SSE events in one frame → exactly one `flush()` / one subscriber notify (unit test with a fake rAF clock).
- Backdrop renders ≤~2k nodes in a single instanced draw call; 60fps held in a profiling harness (record the draw-call integer here).
- Bloom never exceeds max-radius; nodes below min-radius render as static rings (visual snapshot test).
- Scene module imports nothing from `hud/` or the DOM.

**Suggested model (route-cost):** Opus (novel r3f/perf/bloom-collision reasoning — the hardest lane).

---

## Lane C — glass shadcn HUD + semantic-DOM mirror  (CONSUMES the contract)
**Spec:** The RSC shell + two-state screen, the glass HUD (inbox rail, ⌘K, inline
approvals, trace drawer), the SSE client, the React store binding, the token
system, and the mandatory semantic-DOM mirror + aria-live. Pure projection of
`RunState`; never reads the scene.

**Owns (write):**
- `web/app/layout.tsx`, `web/app/page.tsx` (idle submit ⇄ running pipeline, one
  screen two states), `web/app/globals.css`.
- `web/lib/store/useRunState.ts` (`useSyncExternalStore` binding to the contract
  interface), `web/lib/sse/client.ts` (`EventSource` → `reducer.apply`; reconnect
  `hello` resync; never notifies React directly).
- `web/hud/**` — `HudShell`, `PhaseRail` (28px idle rows), `InboxRail` (authoritative
  triage line: requires-you / subtask / severity count / one-line what; glass with
  WebGL particle motion suppressed behind its region), `GateDetail` (sets
  `ui.openDetail`), `ApprovalStep` (① + ⑥), `CommandPalette` (cmdk), `TraceDrawer`
  (`{ts,tool,sig}` mono/tabular; trace never enters the scene), `Toast`
  (non-blocking "Gate D trace ready — view?"), `a11y/DomMirror` (`project_dom`),
  `a11y/LiveRegion` (aria-live), `a11y/announce.ts` (copy patterns + non-color
  badge pairing).
- `web/ui/**` (shadcn glass primitives), `web/styles/**` — `tokens.css` (single
  token source-of-truth), `tailwind.config.ts`.

**"Open detail is sacred" (decision 5):** Gate D auto-opens the trace drawer ONLY
when `ui.openDetail === null`; else demote to a loud inbox item + flare
(severity-ordered), and offer the non-blocking toast on detail close.

**Acceptance check:**
- Tokens in `tokens.css` match ADR §web-design map; automated WCAG AA contrast pass on the four status text tokens over the 6% base at 12px, and glass-opacity-floor holds ≥4.5:1 under a simulated neon-burst composite.
- DOM mirror renders the same `RunState` the scene gets; every color-snap has a paired persistent non-color badge (WCAG 1.4.1); aria-live announces phase/gate/agent-fire changes.
- Gate-D-while-detail-open does NOT hijack (unit test on the `ui.openDetail` guard); toast appears on close.
- SSE client never calls a React setState directly — only the rAF flush notifies (asserted by spying the binding).
- HUD imports nothing from `scene/`.

**Suggested model (route-cost):** Sonnet (large but conventional Next.js/shadcn/a11y surface).

---

## Build & merge procedure (harness-driven)
Cap is 3 lanes (within parallel-build's 3–5). Run from repo root.

1. **Gate A (budget) before spend:** route the 3 lanes into a plan and price it —
   `harness.sh budget <plan.jsonl>` (exits non-zero over ceiling).
2. **Worktrees:** `harness.sh wt-new lane-a-daemon`, `wt-new lane-b-scene`,
   `wt-new lane-c-hud`. Give each agent ONLY its lane spec above + its ownership.
3. **Per-worktree gate (Phase 1):** build + that lane's acceptance check, run the
   app where relevant, then `cross-review` on the worktree diff. A BLOCK or failing
   check does not merge — fix in place.
4. **Sequential merge (order A → B → C, foundational first):**
   `harness.sh integ-start`, then `integ-merge lane-a-daemon` →
   `integ-merge lane-b-scene` → `integ-merge lane-c-hud`. Resolve conflicts
   deliberately at each step (Gate C); run the full suite on `integration` after
   each merge to catch semantic conflicts that passed per-worktree.
   - **Why this order:** A authors the contract everything imports (nothing
     compiles without it); B is the first store consumer and lands the store
     internals against the frozen interface; C lands the HUD/a11y mirror against
     an already-working scene + event stream.
5. **Gate D + Phase 3 evals on integration:** `harness.sh trace <session>`
   (trajectory anomaly check) + `eval-gate` before main.
6. **Promote (after human go):** `harness.sh promote` (guarded ff of base to
   integration). Then `harness.sh clean`.

## Open items to confirm before `wt-new`
- DB choice + schema for `persist.ts` (ADR defers to the `database` skill).
- Tailscale-only deploy + single-slot process supervision (defers to `devops`).
- `security-engineer` threat model on the control endpoints + promote-to-main.
