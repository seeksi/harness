# Umbrella — UI/UX Design System — Committee Package



---

# BRIEF

## Executive summary

**Umbrella** refines the UI/UX design system for the HARNESS Web UI — a dark, futuristic, dense, keyboard-first control panel (Tailscale-only, single expert operator) over a four-phase agent build harness. Structure and visual direction are already locked; this package delivers the **exact tokens, motion language, performance budget, and a blind-spot stress-test** — no code, a system not a mockup.

**What's locked here.** Base surface HSL 222 11% 6% (cool near-black). A five-stop indigo→violet accent ramp hue-shifted by energy (focus stays indigo ~258°, emission trends violet ~274°). Four status hues, each shipping two tokens (fill/glow + a +6–8% text bump for WCAG AA on 12px mono): emerald/teal-green pass ~150°, cyan-blue in-progress ~208° (separated from both base and accent), true/golden amber ~46–48° (maximized distance from red), scarce red. Typography is clinical-first: Geist Sans (13px UI) + Geist Mono (12px data, tabular/lining figures), with Space Grotesk reserved only for large 3D node labels. A 4px grid (restricted scale 4/8/12/16/24/32) with state-tied rows (28px idle floor → 32–36px active alert). Motion is layered: surgical foreground (<200ms ease-out), living ambient layer (600–900ms sine breathing), and an agent-fire bridge (<120ms attack → 400–600ms bloom). Named motion tokens: 1.2–1.8s backdrop energy ramp and 80–120ms severity-ordered co-fire stagger.

**Load-bearing architecture.** One normalized client store (`RunState`) reduced from the SSE stream is the single source of truth; the r3f scene and a mandatory semantic-DOM mirror are both pure projections — neither reads the other, so they cannot drift. This IS decision 15's scene data-model contract and must be frozen, alongside a rAF-aligned batch/flush window, before decomposition.

**Attention model.** Three surfaces, no competition: the graph burst is a pre-attentive textless locator, the inbox rail is the single authoritative triage/action line (requires-you / which subtask / severity count / one-line what), and the phase detail is on-demand dense evidence.

**Stress-test outcomes (new mandatory v1 tokens/rules).** A glass opacity-floor token back-solved from neon-burst worst-case luminance (contrast survives bloom); instanced-only ambient layer + ~2k-node cap at 60fps; max bloom-radius + min node-radius floor (prevents violet/cyan collision under bloom); motion-lite reduced-motion fallback that keeps spatial topology and pairs every color-snap with a persistent non-color badge; 'open detail context is sacred' (Gate D auto-surfaces only when no detail is open, else queues to a loud inbox item and offers a non-blocking toast on close); and a glass inbox rail with WebGL particle motion suppressed behind it as the attentional anchor. Run data persists to DB; no history UI in v1.


---

# PLAN

## Goals

Deliver a complete, build-ready **design system** (tokens + motion language) for the HARNESS Web UI control panel — a private, Tailscale-only, keyboard-first power tool for one expert operator. The engineering team has already locked the structure and visual direction (single-task vertical pipeline, two-state submit screen, non-blocking inbox rail, inline approvals, 3D holographic r3f node-graph over a glass HUD, indigo/violet accent, dark-futuristic base). This package does **not** re-open those decisions. It produces the exact color/type/spacing/motion tokens, a performance budget for the r3f scene, and a blind-spot stress-test that hardens the locked structure without changing its direction.

## Scope

**In scope**
- Color tokens: dark-futuristic base ramp, five-stop indigo→violet accent ramp, four status hues each shipping two tokens (fill/glow + text-bumped), all meeting WCAG AA on the 6% base and on 12px Geist Mono rows.
- Typography: Geist Sans (UI chrome/body) + Geist Mono (data, tabular/lining figures) + Space Grotesk reserved for large 3D node labels; tight scale anchored at ~13px UI / ~12px data.
- Spacing/density: 4px base grid (restricted scale 4/8/12/16/24/32), state-tied row heights (28px idle floor → 32–36px active alert).
- Motion language: layered grammar — surgical functional foreground (<200ms, sharp ease-out), living ambient layer (600–900ms sine breathing), agent-fire bridge (sharp <120ms attack → 400–600ms organic bloom/decay), 1.2–1.8s backdrop energy ramp, 80–120ms severity-ordered co-fire stagger, restrained-spring node settle.
- Reduced-motion (motion-lite) fallback + mandatory semantic-DOM mirror with aria-live.
- r3f performance budget: 60fps target, instanced-only ambient layer, ~2k-node cap, LOD/cull strategy, rAF-aligned SSE batch/flush.
- New mandatory v1 tokens surfaced by the stress-test: glass opacity floor (back-solved from neon-burst worst-case luminance), max bloom-radius, min node-radius floor.
- Blind-spot register with mitigations that stay inside the locked decisions.

**Out of scope / explicitly deferred**
- Any code or working mockup (deliver a system, not an implementation).
- Run-history UI (persist to DB in v1; no UI).
- Re-opening any of the 15 locked decisions.

## Approach

The deliverable is a token system plus a small set of architectural preconditions that the harness's own parallel-build will consume. The load-bearing principle throughout: **one normalized client store reduced from the SSE stream is the single source of truth; the r3f scene and the semantic-DOM mirror are both pure projections of it** — neither reads the other, so they cannot drift. The attention model is fixed by role: graph burst = pre-attentive locator (no text), inbox rail = single authoritative triage/action line, phase detail = on-demand dense evidence. Every visual and motion token is specified to reinforce that hierarchy rather than fight it. Where the 3D holographic aesthetic collides with the functional control-panel job (contrast under bloom, peripheral attention drain, hue collision under bloom, simultaneous UI takeover), the stress-test names a concrete, named-token mitigation that preserves the locked identity.


---

# DECISIONS

## Locked design decisions (with rationale and who argued what)

### Color

**Base surface — HSL 222 11% 6% (cool near-black, blue-grey undertone).** *Mara Solis* offered the choice between blue-grey near-black and true-neutral dark; the *user* chose the cool near-black to harmonize with indigo/violet and give a void for emissive glow, with a guardrail: keep the base undertone hue clearly separate from the status in-progress blue so a surface never reads as a status.

**Accent ramp — hue-shifted indigo→violet, five stops.** *Mara* proposed four vs five stops and single-hue vs hue-shift. The *user* chose a hue shift mapped to energy: UI/focus stays indigo (~258°), emission trends violet (~274°) at full glow so an agent-fire burst reads as a distinct violet flare, not just a brighter focus ring. Five stops: dim-fill (glass HUD tint) → rest-glow (low-energy idle pulse) → mid (border/ring) → vivid (active label/icon) → neon (emissive burst). The idle pulse earns its own low stop so calm-idle never looks active.

**Status hues — four semantics, two tokens each.** *Mara* surfaced two tensions. The *user* resolved: (1) in-progress blue pushed to cyan-blue ~HSL 208 88% 58% for clear hue distance from base (222) and accent (258); (2) amber kept true/golden ~46–48° (not skewed to orange ~38°) to maximize distance from red in the inbox, using the warm-orange band as an empty buffer; green leaned emerald/teal ~150–155° so pass never blends with cyan in-progress. Every status hue ships two tokens — a fill/glow value on the 6% base and a brighter variant (+6–8% lightness) for 12px Geist Mono text to clear WCAG AA 4.5:1.

### Typography

**Geist Sans (UI/body) + Geist Mono (data) + Space Grotesk (3D node labels only).** *Mara* weighed geometric-cold vs sharp-futuristic sans, and utilitarian vs designed mono. The *user* set the voice as precision-instrument clinical first with a restrained futuristic accent: Geist Sans/Mono share a family (native to Next.js + Vercel + shadcn); Space Grotesk reserved for large holographic node titles where density is low. Hard requirement: mono uses tabular/lining figures so cost, time, and ID columns align. Scale tight: ~13px base UI, ~12px data rows.

### Spacing & density

**4px base grid (restricted scale 4/8/12/16/24/32); state-tied row heights.** *Mara* offered 4px vs 8px and 28px vs 32px rows. The *user* chose 4px (finer control, tame noise with discipline not a coarser unit) and tied row height to state: 28px dense floor for idle/inactive rows; active alerts promote to ~32–36px with extra padding. Node sizing and HUD padding derive off the 4px unit; phase-rail resting metric = 28px. This directly serves the attention hierarchy — idle stays tight, the live alert earns breathing room.

### Motion

**Layered motion grammar.** *Theo Brant* asked surgical-instrument vs living-organism and sharp-easeout vs spring. The *user* split by layer: functional foreground = surgical (<200ms, sharp ease-out, machine-precise); ambient layer (backdrop + idle rest-glow pulse) = living organism (600–900ms, soft sine breathing); agent-fire bridges the two with a sharp <120ms attack then an organic ~400–600ms bloom/decay. Restrained spring with minimal overshoot only for 3D nodes settling/orbiting — no bouncy elastic.

**Backdrop energy ramp = 1.2–1.8s ease-in (named token).** *Theo* pushed that 'ambient yet early-warning' is intent, not a token. *User ratified* locking 1.2–1.8s ease-in: slow enough to never read as a status event, fast enough to catch peripheral vision within the agent-fire attack window; build may tune within range.

**Co-fire stagger = 80–120ms severity-ordered (named rule).** *Theo* warned that two simultaneous flares of different hues read as one undifferentiated event. *User ratified* a mandatory 80–120ms severity-ordered offset between burst peaks so co-fires stay individually readable as spatial locators.

### Accessibility / reduced-motion

**Motion-lite for prefers-reduced-motion; mandatory semantic-DOM mirror for AT.** *Yael Okon* asked static-SVG vs motion-lite, and whether anything in the 3D identity is load-bearing. The *user* split by user need: (1) vestibular users get motion-lite — keep 3D geometry and node positions (the operator's spatial mental map is load-bearing; flattening to SVG would be a different tool), freeze all continuous motion, state changes become instant opacity/color steps, agent-fire = instant color snap + brief static highlight, no bloom; (2) screen-reader/non-visual users — a WebGL canvas is opaque to AT regardless of motion, so a parallel semantic-DOM mirror (real HTML + aria-live announcing phase changes, gate escalations, agent fires) is mandatory and doubles as the structured fallback. Load-bearing = spatial topology (kept, frozen) + semantic-DOM equivalent (always present); not load-bearing = continuous animation.

**Color-snap requires a paired persistent non-color badge/label.** *Yael* pushed that in motion-lite the color snap becomes the sole semantic carrier, and WCAG 1.4.1 has no motion exemption. *User ratified* a mandatory persistent non-color badge/label update alongside every color-snap as a non-negotiable accessibility floor.

### Attention hierarchy

**Three roles, three surfaces, no competition.** *Priya Menon* asked what the operator reads in the first 3–5s of a Gate B fire and which surface leads. The *user* fixed the hierarchy: (0–1s) graph burst = pre-attentive locator only (scarce-red, zero text); (1–3s) inbox rail = single authoritative triage + action line ('Gate B – review – st-1 – 2 High'), the single source of truth for action; (3–5s+ on click) phase detail = dense mono evidence where BLOCK/override is decided. The inbox line must convey exactly four things: that it requires the operator, which subtask, severity count, one-line what. Spacing/weight reinforces: inbox alert gets boldest weight + most breathing room when active; graph burst carries no text; detail is dense, on demand.

### Single source of truth

**Normalized client store reduced from SSE; both surfaces are projections.** *Soren Veld* asked what drives both surfaces and whether the sync contract is an open gap. The *user* locked it: `RunState { task, subtasks[], phases, gates[], agentEvents[], budget }` reduced from SSE events. The r3f scene maps state→scene-graph; the DOM mirror maps the same state→semantic HTML + aria-live. Neither reads the other. This IS decision 15's scene data-model contract = the typed store shape + SSE event schema: lane A (daemon/API) produces the event schema; lanes B (r3f) and C (HUD + DOM mirror) consume the store; defining it is a hard precondition before decomposition, locked in the ADR.

### Stress-test resolutions (new mandatory v1 tokens & rules)

**Glass HUD opacity floor = named token back-solved from neon-burst worst-case luminance.** *Mara* and *Yael* argued that backdrop-filter blur composites against whatever the WebGL field emits per-pixel per-frame, so no static token audit holds when a node flares scarlet under an open panel — amber 12px text can drop below 4.5:1. *Dev Nair* noted it's solvable with a CSS clamp. The *user* ratified a named design-system token (a mathematical minimum background-color alpha back-solved from the neon-burst worst-case luminance) over a runtime clamp — auditable and reproducible across the three build lanes.

**rAF-aligned SSE batch/flush layer = pre-decomposition contract requirement.** *Dev* warned the unbatched SSE stream triggers per-event React reconciliation fighting the r3f render loop at Gate B+D co-fire. The *user* locked a rAF-aligned batch/flush layer named now alongside the store schema, as part of decision 15's typed seam — frame-aligned batching is cheap to specify now, structurally hard to retrofit post-decomposition.

**Instanced-only ambient layer + ~2k-node cap = named ceiling now.** *Dev* required the graphify backdrop be a single instanced draw call, not individual meshes, and a named draw-call ceiling. The *user* locked instanced-only + ~2k-node cap now (making 60fps enforceable), with the exact draw-call integer tuned in build profiling.

**Gate D auto-surface qualified: an open detail context is sacred.** *Soren* stress-tested Gate B detail open while Gate D auto-surfaces the trace — a second simultaneous takeover. The *user* qualified decision 5: Gate D auto-opens the trace ONLY when no gate detail/drawer is open; otherwise it demotes to a loud, distinctly-styled inbox item ('trace ready') + graph flare and waits. Inbox stays the single action queue, severity-ordered ('2 gates need you'). On the re-trigger gap *Soren* later named, the *user* chose a non-blocking toast/chip on close ('Gate D trace ready — view?') — operator-initiated, no context hijack, leveraging the attention-transition moment.

**Inbox rail = glass material with WebGL particle motion suppressed behind it.** *Priya* argued a continuously animated 3D scene is a chronic peripheral attentional drain competing with the authoritative triage surface, and that the rail needs perceptual separation. The *user* chose a hybrid: retain the glass material but suppress WebGL particle motion in the inbox-rail region — an attentional anchor that keeps the holographic identity.

**Max bloom-radius + min node-radius floor = mandatory v1 tokens.** *Soren* named a second-order collision: under WebGL emissive bloom the violet neon burst (~274°) and cyan in-progress (~208°) sit ~66° apart on paper, but bloom spreads luminance across hue space, narrowing perceived separation at small node radii. The *user* shipped both a max bloom-radius and a min node-radius floor (below which bursts degrade to static rings) as mandatory v1 tokens — without them the gap is formally unmitigated.


---

# TASKS

## Actionable breakdown

### A. Color token system
1. Author the dark-futuristic base ramp anchored at HSL 222 11% 6%; derive surface/elevation steps keeping every base undertone clearly separated from the cyan in-progress status.
2. Author the five-stop accent ramp: dim-fill (indigo ~258°) → rest-glow → mid → vivid → neon (violet ~274°), hue-shifted by energy. Document which stop maps to glass tint, ring/border, active label/icon, and emissive burst.
3. Author the four status hues — green emerald/teal ~150–155°, cyan-blue in-progress ~208° (HSL ~208 88% 58%), true/golden amber ~46–48°, scarce red. Ship two tokens each (fill/glow on 6% base + text-bump +6–8% lightness).
4. Verify WCAG AA: every status text token ≥4.5:1 on 6% base at 12px Geist Mono; verify amber↔red and cyan↔green separation; verify accent vs status separation.
5. Compute and name the **glass HUD opacity floor** token — minimum background-color alpha back-solved from the neon-burst worst-case composite luminance so 12px text never drops below 4.5:1 under peak bloom.

### B. Typography
6. Define the Geist Sans scale/weights for UI chrome/body anchored at ~13px; define Geist Mono data scale anchored at ~12px with tabular/lining figures enforced for cost/time/ID columns.
7. Specify Space Grotesk usage rules — large 3D node titles only; document the boundary so it never leaks into HUD chrome.
8. Specify diff/trace/path/ID/cost mono treatments ({ts,tool,sig} rows).

### C. Spacing & density
9. Define the 4px base grid with the restricted scale (4/8/12/16/24/32) and usage discipline notes.
10. Define state-tied row metrics: 28px idle floor (phase-step labels, resting inbox), 32–36px active-alert with extra padding; derive node sizing and HUD panel padding off the 4px unit.

### D. Motion language
11. Spec functional-foreground motion: <200ms, sharp ease-out for HUD, focus, phase transitions, trace-drawer open, inbox updates.
12. Spec ambient-layer motion: 600–900ms sine breathing for backdrop field + idle node rest-glow pulse.
13. Spec the agent-fire bridge: sharp <120ms attack → organic ~400–600ms bloom/decay.
14. Name the **backdrop energy ramp token**: 1.2–1.8s ease-in (build may tune within range).
15. Name the **co-fire stagger rule**: mandatory 80–120ms severity-ordered offset between burst peaks.
16. Spec the restrained-spring (minimal overshoot) curve for 3D node settle/orbit; forbid bouncy elastic.
17. Name the **max bloom-radius** and **min node-radius floor** tokens; specify the static-ring degrade behavior below the floor.

### E. Reduced-motion & accessibility
18. Spec the motion-lite fallback: keep geometry + node positions, freeze all continuous motion, state changes become instant opacity/color steps, agent-fire = instant color snap + brief static highlight (no bloom).
19. Spec the **mandatory persistent non-color badge/label** paired with every color-snap (WCAG 1.4.1).
20. Spec the **semantic-DOM mirror**: real HTML projection of RunState + aria-live region announcing phase changes, gate escalations, agent fires. Define announcement copy patterns.

### F. Architecture preconditions (pre-decomposition, decision 15)
21. Define the typed store shape `RunState { task, subtasks[], phases, gates[], agentEvents[], budget }` and the SSE event schema (phase change, subtask status, gate escalation, agent-fire, trace tick, budget). This is the shared seam: lane A produces, lanes B & C consume.
22. Name the **rAF-aligned batch/flush window** in the same contract — one flush per frame between the SSE reducer and both projections.
23. Define both projections as pure (scene ← state; DOM ← state); assert neither reads the other.

### G. r3f performance budget
24. Spec the layered scene: dim ambient graphify world (≤~2k nodes, GPU-instanced points/lines, near-static, aggressive LOD/cull) vs full-detail foreground (~15–40 live nodes).
25. Name the **instanced-only mandate + ~2k-node cap**; set the 60fps target; leave the exact draw-call integer to build profiling.
26. Specify LOD/cull strategy for the ambient layer and confirm trace {ts,tool,sig} events stream to the DRAWER, never into the 3D graph.

### H. Attention-hierarchy & interaction rules
27. Encode the three-surface hierarchy: graph burst = textless locator; inbox rail = single authoritative triage line carrying the four required facts (requires-you / which subtask / severity count / one-line what); phase detail = on-demand dense mono evidence.
28. Spec the inbox-rail region with **glass material + suppressed WebGL particle motion** behind it.
29. Spec the **'open detail context is sacred'** rule: Gate D auto-surfaces trace only when no gate detail/drawer is open; otherwise demote to a loud distinct inbox item + flare, severity-ordered count ('2 gates need you').
30. Spec the **non-blocking toast/chip on detail-close** ('Gate D trace ready — view?'), operator-accepts-or-dismisses.

### I. Packaging
31. Compile all tokens into a single source-of-truth token file/spec for the three build lanes; cross-reference the ADR for the decision-15 contract.
32. Author the blind-spot register as a living document the build phase inherits.


---

# RISKS

## Risk register

| # | Risk | Likelihood | Impact | Mitigation (inside locked decisions) |
|---|------|-----------|--------|--------------------------------------|
| 1 | Glass HUD text drops below WCAG AA 4.5:1 when a node flares under an open panel (backdrop-filter composites live WebGL luminance per-frame) | High | High | Named **glass opacity-floor token**, mathematically back-solved from neon-burst worst-case luminance; auditable across all three lanes; not a runtime clamp. |
| 2 | Unbatched SSE bursts trigger per-event React reconciliation fighting the r3f render loop at Gate B+D co-fire → dropped frames | High | High | Named **rAF-aligned batch/flush** layer locked as a pre-decomposition contract requirement in decision 15's typed seam; one flush per frame feeding both projections. |
| 3 | Ambient graphify graph at ~2k nodes blows the draw-call budget and breaks 60fps | Med | High | Named **instanced-only mandate + ~2k-node cap** now; aggressive LOD/cull on the near-static ambient layer; exact draw-call integer tuned in build profiling. |
| 4 | Violet neon burst (~274°) and cyan in-progress (~208°) visually collide under WebGL bloom at small node radii | Med | High | Mandatory v1 **max bloom-radius** + **min node-radius floor** tokens; bursts degrade to static rings below the floor. |
| 5 | Two simultaneous gate flares read as one undifferentiated peripheral event → locator signal collapses | Med | Med | Mandatory **80–120ms severity-ordered stagger** between burst peaks. |
| 6 | Continuous 3D scene drains peripheral attention and competes with the authoritative inbox triage surface | High | High | Inbox-rail region keeps **glass material but suppresses WebGL particle motion** behind it; fixed three-surface attention hierarchy (graph = textless locator, inbox = sole action line). |
| 7 | Gate D auto-surface hijacks an operator mid-resolution of another gate (B detail open) | Med | High | **'Open detail context is sacred'** rule: Gate D auto-opens trace only when no detail/drawer is open; else demotes to a loud distinct inbox item + flare, severity-ordered. |
| 8 | After closing Gate B detail, queued Gate D re-hijacks at the worst moment (context just reset) | Med | Med | **Non-blocking toast/chip on close** ('Gate D trace ready — view?'); operator-initiated, no takeover. |
| 9 | WebGL canvas is opaque to assistive tech → non-visual operators get nothing | High (certain for AT) | High | Mandatory **semantic-DOM mirror** (real HTML projection of RunState + aria-live announcements); always present, doubles as structured fallback. |
| 10 | In motion-lite, suppressed bloom leaves color-snap as the sole agent-fire carrier → fails color-insensitive users (WCAG 1.4.1) | Med | High | Mandatory **persistent non-color badge/label** paired with every color-snap. |
| 11 | Scene and DOM mirror drift, showing inconsistent state | Low | High | Single normalized store reduced from SSE; **both surfaces are pure projections**, neither reads the other — drift is structurally impossible. |
| 12 | Backdrop energy ramp reads as a status event itself (false alarm) or too slow to serve as early warning | Low | Med | Named **1.2–1.8s ease-in** token — slow enough to not read as status, fast enough for the agent-fire attack window. |
| 13 | Base blue-grey undertone (222°) reads as in-progress status | Low | Med | Cyan in-progress pushed to ~208° for clear hue distance from base (222°) and accent (258°); guardrail documented. |
| 14 | Amber 'needs-you' confused with red 'true-failure' in the adjacent inbox | Med | High | True/golden amber ~46–48° (not orange ~38°) to maximize distance from red; warm-orange band left as empty buffer; separation from indigo via lightness/chroma not hue. |
| 15 | Dense 4px grid + 28px rows produce visual noise / fatigue | Low | Med | Discipline via restricted scale (4/8/12/16/24/32); state-tied row promotion gives active alerts breathing room without loosening the floor. |
| 16 | Space Grotesk leaks beyond 3D node labels, muddying the clinical voice | Low | Low | Hard usage rule: Space Grotesk for large holographic node titles only; Geist Sans/Mono everywhere else. |
| 17 | Trace stream (hundreds of {ts,tool,sig} events) pushed into the 3D graph and chokes it | Low | High | Contract: trace ticks stream to the DRAWER only, never into the scene graph. |


---

# ROADMAP

## Phased roadmap

### Phase 0 — Contract lock (hard precondition, before any decomposition)
This is decision 15's scene data-model contract and must exist before the harness decomposes its own build.
- Lock the typed store `RunState { task, subtasks[], phases, gates[], agentEvents[], budget }` and the SSE event schema (phase change, subtask status, gate escalation, agent-fire, trace tick, budget).
- Name the rAF-aligned batch/flush window inside the same contract.
- Assert the two-renderer rule (scene ← state; DOM ← state; neither reads the other).
- Record all of the above in the ADR.
*Exit criterion:* lanes A/B/C have a frozen seam to build against.

### Phase 1 — Core token system
- Base ramp (222 11% 6% anchor), five-stop indigo→violet accent ramp, four two-token status hues.
- WCAG AA verification pass on 6% base and 12px Geist Mono rows.
- Typography scale (Geist Sans 13px / Geist Mono 12px tabular-lining; Space Grotesk node-label rule).
- 4px grid + restricted scale; state-tied row metrics (28px floor → 32–36px active).
*Exit criterion:* color/type/spacing tokens frozen and contrast-audited.

### Phase 2 — Motion language & emissive-safety tokens
- Functional foreground (<200ms ease-out), ambient layer (600–900ms sine), agent-fire bridge (<120ms attack → 400–600ms bloom).
- Named tokens: 1.2–1.8s backdrop ramp, 80–120ms severity stagger, max bloom-radius, min node-radius floor, restrained-spring node settle.
*Exit criterion:* every motion behavior has a concrete named token/curve.

### Phase 3 — Accessibility & fallback layer
- Motion-lite spec (frozen geometry, instant color steps, no bloom).
- Mandatory persistent non-color badge/label paired with color-snap.
- Semantic-DOM mirror + aria-live announcement patterns.
*Exit criterion:* WCAG 1.4.1 satisfied; AT parity via DOM mirror specified.

### Phase 4 — r3f performance budget & attention rules
- Layered scene (instanced ambient ≤2k / full-detail foreground 15–40), LOD/cull, 60fps target, instanced-only mandate.
- Glass opacity-floor token finalized against neon-burst worst-case.
- Three-surface attention hierarchy; inbox-rail glass-with-motion-suppressed region.
- Gate D 'sacred detail' rule + non-blocking toast/chip on close.
*Exit criterion:* performance ceilings and interaction guardrails named and enforceable.

### Phase 5 — Handoff to parallel-build
The harness builds its own UI via parallel-build across three worktrees, consuming this system:
- Lane A: daemon/control-API — produces the SSE event schema.
- Lane B: r3f 3D scene — consumes the store, applies scene/motion/perf tokens.
- Lane C: glass HUD + semantic-DOM mirror — consumes the store, applies HUD/type/color/a11y tokens.
Merged sequentially. Run outcomes/cost/gate events persist to DB; **no history UI in v1**.
*Exit criterion:* design system delivered as a single token source-of-truth + blind-spot register inherited by the build phase.
