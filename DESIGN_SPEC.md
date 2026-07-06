# DESIGN_SPEC — HARNESS Dashboard Redesign (Umbrella successor)

## Executive summary
A ground-up rebuild of the harness dashboard into a **multi-project agent mission control**: the operating seat where Peter launches, watches, and steers long autonomous harness runs across his projects — 2–3 concurrent run lanes, activity-driven workflow graphs with a full-swarm showpiece view, and full trace forensics underneath. It answers "where is it?" within ten seconds, feels **clear/ordered · technical · busy** (never chaotic), and wears an **industrial-CRT identity**: graphite base, amber phosphor interface voice, green reserved for live/healthy, dark only, DOM-only (the 3D layer is dropped; kinetic energy comes from streaming feeds, agent pulses, and phase-transition punctuation). It is designed for live execution (`HARNESS_LIVE=1` as the normal state), serves from the workstation over tailnet with full-parity phone access and ntfy push on gates/failures/completion, and doubles as a portfolio piece via recorded captures. Success metric: it's genuinely open during every run.

## 1. Essence
- Project type: **Full hybrid** — monitor + explore + control, all first-class (watch runs, drill into traces/diffs/eval history, AND trigger/abort runs, approve gates, edit budgets from the UI)
- Redesign context: **Ground-up rebuild** of the existing "Umbrella" dashboard (`web/`, Next.js 16 + r3f 3D scene + DOM HUD). Current build is reference only. All four pain areas named as broken: information hierarchy (important thing isn't the obvious thing), missing data (traces/costs/review verdicts under-surfaced), staleness/refresh (can't trust what's on screen), and looks/feel. Note: current design system is "locked" by ADR 0001 — this rebuild supersedes that lock (confirm).
- Artifacts: none needed — memory-os serves as the durable output channel; the dashboard is a living tool. No export/report/share-link requirements.
- Purpose (one sentence): **Mission control** — the operating seat for the harness: start runs, watch them, intervene at gates. Command first, observe second.
- The one thing a viewer should think/feel/do within 10 seconds: **"Where is it?"** — pipeline position (current phase, which subtasks are building, what's next) is the dominant answer the screen gives, with act-needed signals riding on top of it.
- 3D scene (r3f layer): **Drop as primary decision** — DOM-only rebuild; information design gets the budget. If resource budget allows at the end, tasteful "cool features" may return as optional garnish — never load-bearing, never carrying information that isn't also in DOM.
- Live premise: **Design for live** — `HARNESS_LIVE=1` becomes the normal state the design is truthful against; the dry-run fixture demotes to dev/demo tooling.
- Desired emotional impact (visceral / behavioral / reflective): **Alive & kinetic** — you should *feel the agents working*: motion, presence, activity as texture. A controlled shout, not a whisper. (Achieved in DOM — the 3D layer is gone; kinetic energy comes from information motion, not decoration.)
- Definition of success (measurable): **It gets used** — the dashboard is open during every harness run instead of being ignored in favor of the terminal. Honest adoption is the metric.
- Explicit non-goals: multi-user/teams (solo-operator tool, no accounts/roles) · long-horizon historical analytics (recent runs only) · in-UI IDE/code editing (viewing diffs and traces is in scope; editing code is not)

## 2. Audience
- Context of use: **Desk, big screen** (primary — full desktop layout) + **phone check-ins over tailnet** (mobile view must carry the 10-second "where is it?" job on its own). No wall-TV mode, no ad-hoc-only usage.
- Primary persona (who, mindset on arrival, device, frequency, technical literacy): The operator (Peter) — expert user, zero on-screen explanation needed for himself; arrives to command and steer **long attended sessions** on heavy/automation tasks. Desk + big screen primary.
- Secondary persona(s): **Portfolio viewers** — the dashboard is explicitly a portfolio piece; visual impressiveness is a first-class requirement and it must be roughly followable by an impressed outsider watching a demo.
- Showcase channel: **recorded captures** — polished screen recordings/GIFs for portfolio pages and posts. Design deliberately for camera moments (the showpiece graph, phase transitions, live feeds). No public deploy, no extra showcase infra; dashboard stays tailnet-only.
- Job(s) the viewer hires this dashboard to do: run mission control for agent workflows across projects — start/steer/approve; see "where is it?" instantly; feel the agents working.
- What they use today instead: terminal (`harness.sh` + Claude Code sessions) and the current Umbrella single-run view.
- **Scope expansion (from interview): multi-project agent operations center.**
  - Project registry: **auto-discover over a named roots list** — a small hardcoded list of parent dirs (e.g. `~/HARNESS`, `~/AGENTS`, `~/projects` — final list confirmed at build) scanned recursively for git repos with `.claude/agents/` and/or harness compatibility. (Note: `/home/alter/AGENTS/_agent-library/` is archived scaffolding, not live agent definitions — exclude.)
  - Run concurrency: **2–3 side-by-side** — a few concurrent runs visible as persistent lanes, one expandable to focus.
  - Workflow graphs use progressive disclosure, **activity-driven**: active/recently-active agents shown; idle niche agents auto-collapse into parent/group nodes. No manual curation.
  - Full-graph view (entire agent worktree): **showpiece moment** — the demo wow-shot, whole swarm alive at once; spectacle first, utility second.
  - Positioning (agreed in interview): harness+dashboard is for long/heavy autonomous work, NOT a Cursor/IDE replacement. Secondary/parallel workflows in-dashboard: yes.

## 3. Brand & feeling
- Mood words (3–5): **clear/ordered · technical · busy** — dense with live activity, but disciplined: every moving thing is information.
- Anti-words (2): **never chaotic, never loose/hard-to-follow** (busy ≠ cluttered; if a viewer can't trace what's happening, it's failed)
- Reference feel to chase: **live build logs** (Vercel-deploy-style streaming), **status boards / timing towers**, **command-and-control energy**.
- Personality sliders (confirmed): Serious 6/7 · Authority 6/7 · High-Tech 7/7 · Detailed/Dense 5/7 · Experimental 5/7 (portfolio flair allowed where it doesn't cost legibility)
- Product name: **build phase proposes 3 names + wordmarks set in the display face; operator picks.** "Umbrella" is not assumed to survive.
- Reference sites loved (feel to chase): Vercel-style live build logs · status boards / timing towers · command-and-control ops rooms. No specific URLs mandated.
- Reference sites hated: none named; anti-references are the anti-words — anything chaotic, loose, hard-to-follow.
- Typography feeling + any required/forbidden typefaces: **Keep Geist (UI sans) + Geist Mono (tabular data) and ADD a distinctive display voice** for project names / big numbers — portfolio flair lives in the display face. (Display face choice: build phase proposes, must fit industrial-CRT direction.)
- Color direction (palette, accent usage, dark/light/both): **Industrial CRT** — graphite/near-black base; **amber phosphor is the interface voice** (accents, emphasis, interactive); **green appears only as live/healthy signal** — split by role, never mixed. Status colors semantically reserved (green=healthy/live, amber doubles as attention within its interface role via intensity, red=failure/blocked, plus one info hue). **Dark only** — one theme executed perfectly; phone view stays dark.
- Motion tolerance: expressive but purposeful. Kinetic energy lives in: **streaming feeds** (log/trace lines flowing — the build-log heartbeat), **agent activity pulses** (working agents visibly breathe: pulses, meters, throughput ticks), **phase transitions** (deliberate punctuation when a phase completes / gate opens). Explicitly NOT chosen: decorative graph choreography — node appear/collapse should be functional and quiet. `prefers-reduced-motion` respected.
- Imagery style: none (no photos/illustration) — the data IS the imagery. Generative texture only if it reads as instrumentation.

## 4. Content & information architecture
- Full page/view inventory — four day-one views:
  1. **Fleet home** (default screen): all auto-discovered projects + the 2–3 active run lanes side-by-side.
  2. **Run focus**: one run expanded — phase rail, subtasks, gates, live feed, budget. The steering view.
  3. **Showpiece graph**: full agent-worktree spectacle view, per project.
  4. **Observability deck**: trace explorer, eval results, review verdicts, memory-os activity — the deep-dive layer.
  (Per-view sections: fleet lanes + ops board in §5 components; run focus hierarchy in §5; deck contents in §6.)
- Navigation model: **Hybrid** — real deep-linkable routes for fleet / run / graph (phone check-ins need URLs; browser back works); observability layers open as drawers/overlays *within* those routes. Command palette (⌘K) for jumps.
- Command surface: **Launch console + palette.** Starting a run is deliberate: a structured launch console (pick project, task brief, budget, model routing → big commit action). Mid-run everything is fast: ⌘K palette for approve/abort/jump; gates approved inline where they appear.
- Copy ownership: agent-drafted microcopy in build phase; operator-facing, no marketing copy. Terminology matches harness vocabulary (phases, gates A–D, worktrees, lanes).
- Asset sources: no external imagery; fonts = Geist, Geist Mono + one display face, delegated to build with constraints: self-hostable, industrial/technical character, fits CRT direction, used ONLY for project names + big numbers.
- Primary action per view: Fleet home → launch/focus a run · Run focus → approve gate / steer · Showpiece graph → (none — spectacle + inspect) · Observability deck → drill into trace/eval detail.
- SEO: N/A — tailnet-only internal tool.

## 5. Interaction & states
- Run-focus visual hierarchy: **phase rail + position owns the top-left quadrant** — the pipeline spine (6 phases, current position, building subtasks, what's next). Gate/action signals ride on the rail but do not displace it; live feed and budget are secondary zones.
- Alerting channels: **phone push (ntfy or PWA notification over tailnet, tap deep-links to the raised gate) + audible chime from the open tab at the desk.** No Slack. In-dashboard display is loud regardless.
- Degraded/stale behavior: **stale badge + freeze** — keep last-known values, show "data as of hh:mm:ss" + a reconnecting indicator. Never blank panels, never silently pretend liveness. (Applies to SSE drop, harness silence, and source staleness alike.)
- Key components and their exact behavior:
  - **Run lane** (fleet home, ×1–3): project name (display face), phase rail with position, health verdict, gate/alert strip, mini burn meter. Click/Enter → run focus route. Alerts sort the lane to top.
  - **Phase rail**: 6 locked phases (decompose · build · route-cost · cross-review · merge · eval+promote); current phase pulses (amber interface voice), completed phases steady, blocked gate burns on the rail at its phase. Identical component at lane-size and focus-size.
  - **Live feed**: streaming agent/tool events, newest at bottom, auto-follow with scroll-lock-on-touch; per-line: timestamp (mono), agent, event, cost tick. Virtualized.
  - **Gate card**: inline where raised — gate id (A–D), what's blocked, evidence links (diff/trace/eval), approve/reject buttons with confirm-on-destructive. Approving from phone = same component.
  - **Launch console**: modal/route — project picker (discovered list), brief textarea (required, non-empty validation), model-routing override (optional); commit action starts run, errors return inline (harness spawn failure shows stderr).
  - **Command palette (⌘K)**: jump to run/project/view, approve/reject named gates, abort run (typed confirmation), toggle deck panels.
  - **Workflow graph**: activity-driven progressive disclosure (idle niche agents collapse into group nodes); full-graph showpiece toggle; pan/zoom; node click → agent state/trace.
  - **Observability deck**: drawer/route with trace explorer (search + filters: run/lane/agent/event type), tool-call detail (full args/outputs/timing), diff viewer per worktree commit, eval results, review verdicts, memory-os activity, burn/eval charts.
- States for every dynamic element: loading = skeleton in-place (no spinners over data); empty = named idle state ("no runs yet — ops board still live"); error = inline red with the actual error text, never a bare toast; success = green pulse then steady. Stale = §5 freeze+badge rule.
- Forms/inputs: launch console is the only real form — brief required (non-empty), project required; validation inline; abort/reject require explicit confirmation; error copy plain and technical, no apology theater.
- Breakpoints & mobile-specific behavior: **Full parity on phone** — everything the desktop has, restacked vertically in the same hierarchy (phase rail/position first, gates, feed, budget, deck). Nothing is desktop-only; approve/reject works from the phone. Two breakpoints: desktop multi-column ≥1024px, single-column stack below.
- Accessibility target: **WCAG 2.2 AA** — amber-on-graphite palette must pass 4.5:1 (palette adjusts if it fails, not the requirement); full keyboard nav with visible focus (keyboard-first is already the interaction model); `prefers-reduced-motion` freezes kinetic texture while keeping information current.

## 6. Data (dashboard branch)
- Task type per view (monitor | analyze | explain): Fleet home = **monitor** · Run focus = **monitor + control** · Observability deck = **analyze** (full forensics: every tool call with full args + outputs + timing, per agent, searchable; diffs viewable per worktree commit) · Showpiece graph = **explain/present**.
- Viewer personas (glance vs deep-dive) and what each must see first: Operator glance (10s) → phase rail position + gate state. Operator deep-dive → observability deck forensics. Camera/portfolio viewer → showpiece graph + kinetic feeds.
- Cost display: **tokens primary, $ secondary/derived** — the operator thinks in tokens/context; dollars are garnish. Per-lane and total both available; context-window fill gauges keep the existing soft-60%/hard-75% thresholds.
- Every metric (source of truth = the `RunState` contract, `web/lib/contract/types.ts`, extended for multi-run/multi-project):
  - **Phase position**: current phase index of 6 locked phases — from daemon phase events. Unit: phase. No threshold; it IS the 10-second answer.
  - **Subtask status**: building/pending/done counts per run — from subtask events. Unit: count.
  - **Gate state**: per gate A–D — raised/approved/rejected — from gate events. Raised = alert condition.
  - **Token burn**: cumulative tokens per lane and per run — summed from usage events. Unit: tokens (primary). Derived $: tokens × route-cost tier rate (tier map in daemon/route-cost plan). Timezone: local; timestamps absolute hh:mm:ss.
  - **Context fill**: per-lane context tokens ÷ model window. Unit: %. Thresholds: soft 60% (amber), hard 75% (red + HANDOFF respawn expected) — existing harness semantics, unchanged.
  - **Health verdict**: healthy / degraded / stuck per run — healthy = events flowing + no raised gates + no anomaly flags; degraded = stale feed or amber conditions; stuck = trajectory anomaly (loop/call-explosion/thrash from eval-gate trace check) or no events past staleness window. Exact staleness window: 60s without any event while phase incomplete.
  - **Eval scores**: regression pass/fail + capability scores per run — from eval-gate output. Unit: pass/fail + score.
- Event-source scope: **harness now, adapter later** — day one, every visualized workflow is a harness run launched from this dashboard (single event source: the daemon). The event schema, however, must be designed provider-agnostic (runId/projectId/agentId envelope, typed events) so an external-system adapter (e.g. independently-running dropshipping agents) can be added later without reworking the store or views. No external adapter is built now.
- Data sources: daemon SSE stream (sole event producer; two producers behind it — fixture for dev, live `harness.sh` bridge for real runs); SQLite (`web/data/umbrella.db` or successor) for run snapshots/event log/audit + 20-run retention; memory-os ledgers (JSONL) for memory activity panel; route-cost plan files (`data/plans/plan-*.jsonl`) for routing/budget; project discovery scanner over the named roots list. Credentials: all local; operator owns everything.
- Refresh cadence & mechanism: **SSE push** end-to-end — no polling while connected; reconnect with backoff on drop (freeze+badge meanwhile); event-log replay on reconnect so no gaps. "Data as of" timestamp always rendered from last received event.
- Chart mapping: **dense + real charts.** Sparklines/meters inline everywhere (throughput, burn, context fill); proper charts live in the observability deck: token burn over time (line), per-lane comparisons (bars), eval score history (line/dots). Axes start at zero; no dual-axis; no pies.
- Interactivity: search across trace forensics; filters in deck (run, lane, agent, event type); drill-down floor = individual tool call with full args/outputs/timing + per-worktree-commit diffs; deep-linkable routes for fleet/run/graph; no CSV/PDF export (memory-os is the durable output channel).
- Alerting: conditions = **gate raised · run failed or stuck (incl. trajectory anomalies: loops, call explosions, thrash) · run completed**. Channels: phone push (ntfy/PWA, deep-link to the item) + desk chime from open tab. Visual: alerts sort to top of the lane, red for fail/stuck, green pulse for complete, amber burn for gates. Explicitly not alerted: budget %, context hard-limit (visible on-screen only).
- Degraded states: stale data, empty data, source down → **freeze + badge** per §5 ("data as of hh:mm:ss", reconnect indicator, never blank, never fake liveness). True zero vs missing data must render differently (0 vs "—" + badge).
- Density preference (executive-sparse | analyst-dense) per view: **analyst-dense** throughout — "busy" is the chosen mood; discipline comes from hierarchy, not sparsity. Phone restacks same density scrolled.
- Retention & volume: **last ~20 runs per project** with full forensics retained; older pruned automatically. UI defaults to recent runs.
- Performance expectation: kinetic layer holds **60fps** on operator hardware; phone load <3s over tailnet; feeds cap their DOM (virtualized/ring-buffered) so long runs don't degrade.

## 7. Practicals
- Deploy target: **Workstation (this machine), tailnet-exposed** — the dashboard serves from where the projects and `harness.sh` live, reachable from the phone over Tailscale. The VPS `umbrella.service` deploy is retired for this rebuild (may later host a fixture demo, out of scope).
- Domain: tailnet address / MagicDNS name; no public domain.
- Env vars / secrets / third-party integrations: existing harness flags (`HARNESS_LIVE`, `ENABLE_PROMOTE_TO_MAIN`, `ENABLE_MEMORY_OS`, `HARNESS_PLAN_DIR`…) + new `NTFY_TOPIC`/`NTFY_URL` for push. **ntfy** is the push transport (HTTP POST server-side, ntfy app on phone). No other third parties.
- Analytics: none.
- Performance budget: kinetic layer 60fps on operator hardware; phone load <3s over tailnet; feeds virtualized/ring-buffered so multi-hour runs don't degrade.
- Browser/device support floor: evergreen Chromium + iOS/Android current Safari/Chrome (phone check-ins). No legacy support.
- Legal pages: N/A — private internal tool.
- Launch console contract: **required = project (from discovery) + task brief**; **offered = model-routing override** (route-cost tier map per run). Token budget and lane count are NOT user-set at launch — budget comes from route-cost defaults; lane count is system-managed within safety caps.

## 8. Definition of done (build must satisfy ALL)
- [ ] Every view/section in §4 exists and matches §3 direction
- [ ] Every state in §5/§6 is implemented (loading/empty/error verified)
- [ ] Accessibility target met
- [ ] Performance budget met
- [ ] Deployed/reachable at the §7 target (workstation, tailnet URL opens from phone)
- [ ] A real live run (`HARNESS_LIVE=1`) driven end-to-end from the UI: launch console → phases stream → gate approved in UI → promote preview reached
- [ ] 2–3 concurrent run lanes render legibly side-by-side (fixture-driven acceptable for the multi-lane test)
- [ ] Phone: full-parity view over tailnet; a gate can be approved from the phone
- [ ] ntfy push arrives on gate-raise/fail/complete and deep-links to the item
- [ ] Kill the SSE stream mid-run → freeze + "data as of" badge + reconnect + gapless replay, verified
- [ ] Showpiece graph produces a capture-worthy recording (smooth pan/zoom, collapse/expand, 60fps)
- [ ] Trace forensics searchable down to individual tool call args/outputs; 20-run retention enforced

## Sign-off
- 🔧 Dev Team: "I could build this with no design decisions left to make." — 2026-07-06
- 🏛 Planning Committee: "This fully captures the vision." — 2026-07-06
