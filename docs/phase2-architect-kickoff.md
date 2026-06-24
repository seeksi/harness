# Phase 2 kickoff — Architect ADR for the Umbrella Web UI

Paste this to a Claude Code session **rooted at `~/HARNESS`** (so the project-scoped
`architect`, `web-design`, `frontend`, `security-engineer` agents resolve):

---

Use the **architect** agent to produce an implementation-ready ADR for the
Umbrella Web UI (the holographic control panel over this harness), from the
committee design package.

**Read first:**
- `docs/umbrella-ui-design-package.md` — the committee-deliberated design system
  (brief, plan, decisions, tasks, risks, roadmap). All visual/UX decisions are
  LOCKED there; do not re-open them.
- `~/.claude/plans/find-the-most-recent-sequential-wigderson.md` — the 15 locked
  decisions + phasing context.

**Produce `docs/adr/0001-umbrella-ui-design.md`** containing:
1. **Context** — what Umbrella is and why (one paragraph), linking the package.
2. **The scene data-model contract (load-bearing).** Define the typed
   `RunState` store reduced from the harness SSE stream, the SSE event schema
   that feeds it, and the rule that the r3f scene graph **and** the semantic-DOM
   mirror are *pure projections* of it (neither reads the other). Include the
   rAF-aligned batch/flush window. This is the seam all lanes share — freeze it
   here, before decomposition.
3. **Module/component boundaries + per-file ownership** — unambiguous enough that
   `parallel-build` can decompose without guessing.
4. **The 3-lane decomposition** for `parallel-build`:
   (a) daemon + control-plane API (drives `harness.sh`, emits SSE);
   (b) the r3f 3D scene (node-graph, ambient backdrop, agent-fire motion,
       instanced ambient layer + ~2k cap, bloom/node-radius floors);
   (c) the glass shadcn HUD (gate-inbox rail with motion suppressed behind it,
       ⌘K, inline approvals, trace drawer, the semantic-DOM mirror + aria-live).
   Note which lanes consume the scene contract.
5. **Consequences + alternatives** considered.

Pull in `web-design` for token/component specifics, `frontend` for the
Next.js/RSC + react-three-fiber mapping, and `security-engineer` for the Max-plan
credential surface (the backend holds the auth). **No production code — ADR only.**
Then stop for review before `parallel-build`.

---

After the ADR is approved, Phase 3 is `parallel-build` on the 3-lane
decomposition — the harness building its own UI.
