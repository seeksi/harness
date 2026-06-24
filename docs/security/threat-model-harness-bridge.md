# Threat Model — harness-bridge (live execution + promote-to-main)

- Status: **AUTHORIZED (signed 2026-06-24)** — all **Gate checklist (§7)** items are
  satisfied and verified on the live VPS, and the model is signed off (§8). Enabling
  live execution / promote-to-main mutation remains a deliberate, separate operator
  action: `ENABLE_PROMOTE_TO_MAIN` stays unset and the daemon stays on the dry-run
  fixture until explicitly flipped.
- Date: 2026-06-23
- Scope owner: security-engineer (operator). Reviewers: TBD.
- Depends on: [ADR 0001](../adr/0001-umbrella-ui-design.md), `docs/umbrella-ui-design-package.md`.
- Subject code: `web/lib/daemon/harness-bridge.ts`, `web/lib/daemon/daemon.ts`,
  `web/app/api/runs/**`, `web/lib/api/csrf.ts`, `web/lib/store/persist.ts`,
  `.claude/skills/harness/harness.sh`.

---

## 1. Why this exists

`harness-bridge` is the only component that turns operator intent into **process
execution and git state mutation** on the host. Today it is a *secure foundation,
not wired live*: `buildArgs` + `spawnHarness` exist and are tested, but the daemon
still replays the `dryRun` fixture and `promote-to-main` is preview-only behind a
default-off flag. Flipping either of those crosses the most consequential trust
boundary in the system — arbitrary-ish `harness.sh` invocation and a fast-forward
of `main`. This document enumerates the threats on that path and defines the
conditions under which it may be enabled.

## 2. Assets

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | The host shell / process table | `harness.sh` runs real commands; injection = RCE on the host |
| A2 | The git repository + `main` branch | `promote` fast-forwards `main`; a bad promote rewrites the source of truth |
| A3 | The host filesystem (worktrees, `data/umbrella.db`, `.env*`) | path traversal / arbitrary write or read |
| A4 | Credentials — Max-plan session, any residual `ANTHROPIC_API_KEY`, git push tokens | exfiltration / privilege escalation |
| A5 | Run integrity + audit trail (`runs`/`events` tables) | tampering hides what happened |
| A6 | Availability of the single operator slot | DoS locks the operator out |

## 3. Trust boundaries & assumptions (must hold for this model to be valid)

- **TB-1 Network = perimeter.** Reachable only over Tailscale; no public exposure;
  no in-app authn (decision: the network is the authn). *Assumption: Tailscale ACLs
  restrict the node to the single operator's devices.* If this breaks, every threat
  below escalates — there is no second line of defense for identity.
- **TB-2 Single operator, single slot.** One run at a time (SQLite `slot` row).
- **TB-3 Server is the sole credential holder.** The browser never receives
  credentials; `ANTHROPIC_API_KEY` is deleted to force the Max-plan subscription.
- **TB-4 `harness.sh` is trusted local code**, but it interpolates `$2` **unsanitized**
  into git commands — so the bridge must never hand it an attacker-influenced string.
- **TB-5 The browser/client is untrusted input** even though the operator is trusted:
  a malicious web page in the operator's browser is the realistic attacker (CSRF).

## 4. Data flow (the execution path)

```
browser ──POST /api/runs/[id]/{approve,gate}── Next route (nodejs runtime)
            │  csrf guard: X-Umbrella-Request:1 + Sec-Fetch-Site:same-origin + same-origin(host+scheme), no CORS
            ▼
        daemon (single producer, single slot)
            │  buildArgs(validated enum/regex) → spawnHarness(shell:false)
            ▼
        harness.sh <subcommand> <validated-arg>   ──→ git / filesystem / processes
            │  stdout: line-delimited JSON only (parseHarnessLine), stderr: drained, not forwarded
            ▼
        broker → SSE stream → browser (structured events only; never raw output, never creds)
```

## 5. STRIDE analysis

Severity is residual (after the current mitigation). "Pre-wire" = the mitigation
must exist before live execution is enabled.

| ID | Threat (STRIDE) | Vector | Current mitigation (in code) | Residual | Required before enable |
|----|-----------------|--------|------------------------------|----------|------------------------|
| T1 | **Tampering/Elevation** — command injection on the host | client string reaches `harness.sh $2` / a shell | **DONE** — ALL `buildArgs` args (slugs, sessions, plan files) gated by a server-owned provenance registry (`registry.ts`): only server-minted values pass; regex demoted to mint-time shape check; `spawnHarness` uses `shell:false`; args server-constructed; no raw client string reaches harness.sh | Low | Done. (Plan-file *path containment* — resolving the minted name under a fixed dir — remains T5.) |
| T2 | **Tampering** — unauthorized `promote` rewrites `main` | CSRF-driven approve, or daemon auto-promote | `promote` preview-only behind `ENABLE_PROMOTE_TO_MAIN` (default off) at BOTH the approve route and `spawnHarness`; ff-only | Med (highest-value target) | Human-in-the-loop confirm on every promote; ff-only verified; **audit log entry per promote**; flag stays off until §7 complete |
| T3 | **Spoofing** — forged state-changing request | malicious page in operator's browser | custom header (no CORS ⇒ cross-origin preflight fails) + `Sec-Fetch-Site: same-origin` + same-origin host+scheme | Low | Re-confirm no route mutates on GET; keep no-CORS |
| T4 | **Information disclosure** — credential/secret leak to client | secret in `harness.sh` output forwarded over SSE | **DONE** — `parseHarnessLine` validates each event against a per-type schema and copies only whitelisted fields (nested `counts` reduced too); a smuggled extra field is dropped; stderr drained; browser never sees env | Low | Done. Still TODO: assert no `ANTHROPIC_API_KEY` in the env on the browser-facing path (separate §7 box). |
| T5 | **Information disclosure / Tampering** — path traversal (read/write outside repo) | `planFile`/slug containing `/` or `..` | **DONE** — provenance (minted) + bare-filename regex; plus `containedPlanFile` resolves the name under a fixed allow-dir (`HARNESS_PLAN_DIR`, default `data/plans`) and rejects any path that escapes it — an independent second layer, unit-tested against `../`, `/etc/...`, `a/../../b` | Low | Done. |
| T6 | **Denial of service** — host hang / slot lockout | child fills stderr pipe; unbounded buffers; stuck slot; orphaned subprocess tree | **DONE** — stderr drained; SSE buffer bounded (`MAX_PENDING`); single-slot lock; `spawnHarness` deadline (`HARNESS_TIMEOUT_MS`, default 10 min) kills the whole **process group** (`detached` + `-pid`) SIGTERM→SIGKILL and settles only on `close` (slot held until the child truly exits → no overlap with the next run), rejecting `HarnessTimeoutError` so the daemon releases the slot + persists `failed` | Low | Done. |
| T7 | **Repudiation** — no record of what ran | — | **DONE** — append-only `audit` table written on every `spawnHarness` settle (argv + outcome + ts + exit code). Mandatory (the SQLite write always runs; `onAudit` only observes). **Never stores stdout/stderr or the error message** — only the error CLASS name (+ safe errno), since the message can embed the rejected value | Low | Done. |
| T8 | **SSRF** | client-supplied URL fetched server-side | none needed — no client input becomes an outbound URL | N/A | n/a |
| T9 | **Elevation via boundary leak** — non-allowed code imports the store impl / bridge | a new module bypasses the eslint denylist | **DONE** — `no-restricted-imports` default-denies the client store impl (`lib/store/{store,raf-flush}`) and the harness spawn (`lib/daemon/harness-bridge`) by `@/` specifier; only allowlisted files (`runtime/useRunSession.ts`, `lib/daemon/daemon.ts`) re-enable them, so a NEW module can't slip past an enumerated denylist. Lane B↔C isolation zones retained | Low | Done. |
| T10 | **Supply chain** — `harness.sh` itself altered | local script tampered | trusted local code (TB-4) | Low | Out of scope here; covered by host integrity |

## 6. The `promote-to-main` deep-dive (T2, highest value)

Promote is the only operation that mutates the durable source of truth. It must
remain the most guarded path:

1. **Default-off flag** (`ENABLE_PROMOTE_TO_MAIN`) gates it in two places — the
   approve route returns preview-only, and `spawnHarness` refuses to spawn
   `promote` — so a single missed check does not enable mutation.
2. **CSRF** is the realistic attacker (T3): the custom header + no-CORS makes a
   cross-origin promote infeasible; the highest-severity scenario is therefore a
   same-origin XSS, which the dark, dependency-light, no-`dangerouslySetInnerHTML`
   UI must continue to avoid (re-audit on every UI dep add).
3. **ff-only** — `harness.sh promote` is `git merge --ff-only`; it cannot create a
   merge or rewrite history, only advance `main` to an existing reviewed tip.
4. **Human go** — promote requires explicit operator confirmation; never automatic.

## 7. Gate checklist — ALL required before enabling live execution / promote mutation

- [x] T1 — `buildArgs` slugs/sessions sourced from a **server-owned provenance registry** (`web/lib/daemon/registry.ts`): only server-minted values reach `harness.sh`; the regex is demoted to a mint-time shape check. (Plan-file path containment remains T5, below.)
- [x] T4 — **per-event-type schema validation** in `parseHarnessLine` (whitelist fields + validate enums/required; nested `counts` reduced too). Tests prove a smuggled extra field is dropped and bad enums/missing fields drop the event.
- [x] T4 — credential isolation enforced unconditionally at process start: `instrumentation.ts` `register()` calls `stripServerCredentials()` — deletes `ANTHROPIC_API_KEY` + the explicit denylist **and any credential-NAMED env** (`API_KEY/SECRET/TOKEN/PASSWORD/…` pattern), forcing the Max-plan subscription and leaving nothing in `process.env` to reflect. Stripped VALUES are fingerprinted in memory (never logged) so the browser-facing `assertNoCredential()` guard (on the SSE `hello` snapshot) fails closed on a leaked NAME **or VALUE**. Unit-tested incl. value-leak + pattern-strip.
- [x] T5 — plan-file resolution constrained to a fixed allow-dir (`HARNESS_PLAN_DIR`, default `data/plans`) with a containment assertion (`containedPlanFile`); resolved to an absolute path that cannot escape the dir; unit-tested against traversal/absolute escapes.
- [x] T6 — `spawnHarness` has a **timeout + kill** (deadline → SIGTERM → SIGKILL, rejects `HarnessTimeoutError`); a hung child releases the slot via the daemon's catch/finally. Default 10 min, override `HARNESS_TIMEOUT_MS`.
- [x] T7 — **audit log** of every spawn (argv + outcome + ts + code, no secrets): append-only `audit` table in `persist.ts`, written by `spawnHarness` at every settle point (exit/timeout/error/refused/invalid-args), on by default.
- [x] T9 — eslint import-boundary converted to an **allowlist** (`no-restricted-imports` default-deny on the store impl + harness spawn; only `runtime/useRunSession.ts` and `lib/daemon/daemon.ts` re-enabled). Verified a non-allowlisted importer errors.
- [x] TB-1 — Tailscale perimeter verified on the live VPS (`ubuntu-2gb-ash-1`, `100.86.74.120`): Funnel off; Umbrella binds the tailnet IP only (`100.86.74.120:3000`, no `0.0.0.0`); tailnet ACL tightened from default allow-all to a member-scoped grant (`autogroup:member → autogroup:member`, no wildcard `src`). Verified reachable over the tailnet without lockout. (Pre-existing public `nginx` on `0.0.0.0:80/443` noted separately — not part of Umbrella's surface.)
- [x] `harness.sh` emits **line-delimited JSON events** on stdout (the contract `parseHarnessLine` consumes) — `phase`/`subtask`/`gate`/`agentFire`/`approval` around each subcommand, with sibling/git human output routed to stderr so stdout is a pure JSON channel. A contract test runs the real script against a throwaway repo and asserts every line passes `parseHarnessLine`.
- [ ] This document reviewed and signed off (§8).

Until every box is checked: `ENABLE_PROMOTE_TO_MAIN` stays unset, and the daemon
producer stays on the dry-run fixture.

## 8. Sign-off

| Role | Name | Verdict | Date |
|------|------|---------|------|
| Security review | Claude (cross-model gate, Claude × Codex) | PASS | 2026-06-24 |
| Operator | Peter Vance | APPROVED | 2026-06-24 |

**Decision:** AUTHORIZED. All §7 gate items are satisfied and verified on the live VPS
(TB-1). Live harness execution and promote-to-main mutation are authorized to be
enabled — but stay OFF by default: `ENABLE_PROMOTE_TO_MAIN` remains unset and the
daemon stays on the dry-run fixture until the operator explicitly enables them, which
additionally requires (a) wiring the daemon to `spawnHarness` (mint lanes/sessions)
and (b) Max-plan auth on the VPS. Flipping the flag is a deliberate, separate action.

## 9. TB-1 review runbook (operator)

The network IS the perimeter (no in-app authn, ADR decision). TB-1 passes only if
ALL of these hold; run on the host and record the outcome in §8.

1. **Not publicly exposed via Tailscale.** Funnel must be OFF for this service:
   - `tailscale funnel status` → expect "no funnels" (nothing forwarding the app port to the internet).
   - `tailscale serve status` → if used, confirm it serves only inside the tailnet, not Funnel.
2. **Server binds to the tailnet/loopback, not a public/LAN NIC.** Confirm how the
   Next.js server is started — it must bind the Tailscale IP (100.64.0.0/10) or
   127.0.0.1, never 0.0.0.0 on a public/LAN interface:
   - `ss -ltnp | grep -E ':3000|next'` (or your port) → the Local Address must be a `100.x` or `127.0.0.1` address, not `0.0.0.0`.
3. **ACL restricts access to the operator only.** In the tailnet ACL policy, the
   rule granting the app port must list only the operator's user/device/tag (e.g.
   `tag:umbrella` or `petervance04@…`), with no wildcard `*` source:
   - Review the admin console ACL JSON (`acls` + `grants`); confirm no `"src": ["*"]` reaches the app port.
4. **No other nodes can reach it.** From a non-operator device (or check ACL), the
   port is unreachable.

Record: who reviewed, date, and the `ss`/`funnel`/ACL evidence summary in §8.

---

_skipped: formal attack trees / DREAD scoring — STRIDE + the gate checklist is enough
at this scale; add quantitative scoring if the operator/reviewer set grows._
