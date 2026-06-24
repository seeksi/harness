# `lib/contract/` — the frozen seam

This directory is the **single shared surface** the three parallel-build lanes compile
against. It is frozen by [ADR 0001 §2](../../../docs/adr/0001-umbrella-ui-design.md) and
the [NOTES.md Lane 0 spec](../../../NOTES.md). **Lanes import from `lib/contract/**` only —
they never redefine these types or this interface.** Authored by Lane A; everyone else
is import-only.

## The two-renderer rule

There is exactly **one** source of truth on the client: a normalized `RunState`, reduced
from the SSE stream. Both rendered surfaces are **pure projections** of it:

- `project_scene(RunState) → scene-graph` — Lane B, r3f. Reads the store in the frame
  loop; **never reads the DOM**.
- `project_dom(RunState) → semantic HTML + aria-live` — Lane C. **Never reads the scene.**

The only legal write path into either projection is the store. Drift between the
holographic view and the accessible view is therefore structurally impossible. Any
cross-surface fact (e.g. "gate detail is open") lives in `RunState.ui`, not in a component.

## The rAF flush

The raw SSE stream is **not** wired into React reconciliation per event:

- SSE handler → `store.apply(event)` accumulates deltas into a pending buffer. **No React
  notify.**
- A single `requestAnimationFrame` loop calls `store.flush()` **once per frame**: commits
  the buffer, bumps the store version, notifies subscribers (React via
  `useSyncExternalStore`; r3f via a frame-loop read of `getSnapshot()`).
- At a Gate B + Gate D co-fire burst, N events collapse into **one** reconciliation pass
  per frame instead of N. The co-fire stagger (80–120ms, severity-ordered) is computed
  from `firedAt` deltas **at flush time**, not from event-arrival jitter. See
  `fixture.ts` for the canonical co-fire case.

## Disjoint ownership (no file is co-written)

| Surface | Lives in | Owner |
|---|---|---|
| Store **interface** (`createStore`/`getSnapshot`/`subscribe`/`apply`/`flush`) | `lib/contract/store.ts` | Lane A (type-only; imported by all) |
| Store **implementation** (`store.ts`, `raf-flush.ts`) | `lib/store/` | Lane B (sole writer) |
| React **binding** (`useRunState.ts`, `useSyncExternalStore`) | `lib/store/` | Lane C (sole writer; imports the interface from contract, never B's internals) |

## Files in this directory

- `types.ts` — `RunState` and its members, plus `TRACE_WINDOW` (ring-buffer cap shared by
  B's store and C's drawer) and `initialRunState` (the canonical idle value;
  `getSnapshot()` is defined before any event).
- `events.ts` — the `SSEEvent` discriminated union (the wire contract) + the `reducer`
  **signature**. The body throws `"reducer: implemented in Lane A"` — Lane 0 freezes the
  signature only. The reducer must be total over the union and drop any unknown `type`
  (forward-compat); `subtask` deltas **merge**, `hello` **replaces wholesale**.
- `store.ts` — the `RunStore` interface + `CreateStore` type. Type-only.
- `fixture.ts` — `export const dryRun: SSEEvent[]`, the canonical deterministic transcript
  (hello → phases/subtasks → budget → trace → **Gate B+D co-fire burst** → resolve →
  approval → promote-preview tail). B and C build against the same bytes.

## Pinned dependency versions (Lane 0 scaffold)

Exact-pinned in `web/package.json`. The repo's Next.js differs from training data — these
are the current stable versions as of the Lane 0 scaffold (2026-06-23):

| Package | Version |
|---|---|
| next | 16.2.9 |
| react / react-dom | 19.2.7 |
| typescript | 6.0.3 |
| three | 0.184.0 |
| @react-three/fiber | 9.6.1 |
| @react-three/drei | 10.7.7 |
| tailwindcss / @tailwindcss/postcss | 4.3.1 |
| better-sqlite3 | 12.11.1 (Lane A; Node-only) |

Tailwind is v4 (`@import "tailwindcss"` + `@tailwindcss/postcss`, no `tailwind.config.ts`
required — Lane C's `styles/tailwind.config.ts` maps tokens when it lands).
`better-sqlite3` is a real Lane A dependency (SQLite WAL, no ORM); it is Node-only and
must only be imported behind `export const runtime = "nodejs"` routes.
