# Group C — live-session smokes (operator, needs running server + creds)

Follow-ups batch, Group C: the three live smokes that can't run in CI because they need a
reachable console over the tailnet, a phone, and (for C0/agent runs) `ENABLE_AGENT_EXEC` +
a Max-plan session. Groups A (code, committed) and B (drop-mode already-landed + docs
reconciled) are closed; this is what's left, all operator-hands.

Run these in one live session. Do them in order — C0 brings the environment up; C1–C3 each
produce a durable artifact (screenshot / phone confirmation) proving the path end-to-end.

**Live targets** (from `docs/HANDOFF-17c.md`): VPS `deploy@178.156.247.151`, console on the
tailnet at `100.86.74.120:3000`. Local/workstation console also serves over the tailnet.
**Standing rule:** don't self-approve agent-exec or weaken egress/isolation; prod VPS
state-changes (users/sudoers/systemctl) need explicit per-action authorization or a `!`-run.

---

## C0 — Bring the live session up (prerequisite for C1–C3)

Two ways in, pick per what you're smoking:

- **Console-only smokes (C1 graph, C2 approve UI, C3 ntfy tap)** — just need the app
  reachable on the tailnet. Local: `gantry up --host <tailnet-ip> --port 3000` (sets
  `HARNESS_LIVE=1 ENABLE_AGENT_EXEC=1 LANE_CONCURRENCY=<lanes>`; add `--fixture` for a
  seeded run with no real agent). Verify: `curl -sS http://<host>:3000/ -o /dev/null -w '%{http_code}\n'` → `200`.
- **Real agent run behind the smokes** — on the VPS, complete the 17c-final operator
  sequence in `docs/HANDOFF-17c.md` (fix `agent-1` user-manager scope → bootstrap each
  lane's Max-plan session → `sudo bash deploy/tier3/conformance-multilane.sh` = 17/17 →
  set `LANE_CONCURRENCY=3` drop-in → flip `HARNESS_LIVE=1`). Flip `HARNESS_LIVE=0` after.

**PASS C0:** console returns 200 over the tailnet; if doing a real run, `conformance-multilane.sh` = 17/17 and one lane reaches build→gate.

---

## C1 — /graph showpiece capture

- **Goal:** a clean screenshot of the graph swarm view (the showpiece), refreshing the
  repo's `graph-swarm.png`.
- **Surface:** `console/app/graph/page.tsx` (roster fold) → `/graph`; per-project drill at
  `/graph/[projectId]`.
- **Steps:**
  1. With the console up (C0), open `http://<host>:3000/graph` in a real browser to confirm
     it renders (roster resolves, nodes/edges laid out, no error boundary).
  2. Capture headless via Playwright MCP: `browser_navigate` → `http://<host>:3000/graph`,
     `browser_wait_for` the graph canvas/roster to settle, `browser_take_screenshot` at a
     wide viewport (e.g. 1600×1000). Save to `graph-swarm.png` in the repo root.
- **PASS C1:** screenshot shows the populated swarm (not an empty/loading state);
  `graph-swarm.png` updated. Artifact: the PNG.

## C2 — phone-approve over tailnet

- **Goal:** approve/reject a raised gate from a phone on the tailnet, hitting the live gate
  endpoint — proves the operator can drive gates off-desk.
- **Surface:** run-focus page `/run/[id]` (RunLane approve/reject) →
  `POST /api/runs/[id]/gate` with `{ gateId ∈ {A,B,C,D}, status ∈ {approved,rejected,clear,raised} }`
  (`console/app/api/runs/[id]/gate/route.ts`; 404 unknown run, 422 bad input, 503 when writes
  disabled). Gate D `approved` additionally requires `ENABLE_PROMOTE_TO_MAIN=1`.
- **Steps:**
  1. Get a run with a raised gate — a real run that hits Gate A/B, or a `--fixture` run
     seeded to a raised gate. Note its `runId`.
  2. On the phone (same tailnet), open `http://<host>:3000/run/<runId>`, tap **Approve**
     (or **Reject**) on the raised gate.
  3. Confirm the desk console reflects the decision live (SSE), and the gate envelope is
     recorded on the run.
- **PASS C2:** phone POST returns 2xx; gate transitions to approved/rejected; desk view
  updates without refresh. Artifact: phone screenshot of the approved gate + the run's gate envelope.

## C3 — ntfy tap (deep-link)

- **Goal:** a real ntfy push lands on the phone and tapping it deep-links to the exact run —
  closes the #5 loop end-to-end (code already verified; this is the live confirmation).
- **Surface:** `console/lib/server/notifier.ts` — fires on gate-raised / run-failed /
  run-stuck / run-completed; `Click` header = `deepLink()` = `CONSOLE_BASE_URL`
  (alias `NTFY_DEEPLINK_BASE`) + `runRoute(runId)` (`/run/<id>`).
- **Env (server, before the run):**
  - `NTFY_URL` — the ntfy server (e.g. `https://ntfy.sh`)
  - `NTFY_TOPIC` — a chosen topic; subscribe the phone's ntfy app to it
  - `CONSOLE_BASE_URL` — the tailnet-reachable console base, e.g. `http://100.86.74.120:3000`
    (this is what the phone tap must resolve to — set it to a URL the phone can actually reach)
- **Steps:**
  1. Set the three env vars on the console/daemon process; subscribe the phone to `NTFY_TOPIC`.
  2. Trigger one of the alert conditions (raise a gate, or let a fixture run complete).
  3. On the phone: receive the push (title `<kind> · <project>`, correct priority/tags), then
     **tap it**.
- **PASS C3:** the push arrives; tapping opens `CONSOLE_BASE_URL/run/<runId>` and lands on the
  correct run-focus page. Artifact: phone screenshot of the notification + the opened run page.

---

## Close-out
When C1–C3 pass, record in `NOTES.md` (append under "## Group B — CLOSED") a "Group C —
DONE" line with the artifacts, refresh `graph-swarm.png`, and the follow-ups batch is fully
closed. Nothing here merges or pushes without operator say-so.

skipped: automating C2/C3 (they're deliberately manual phone smokes), add when a
device-farm/emulator harness exists.
