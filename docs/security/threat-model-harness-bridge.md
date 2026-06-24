# Threat Model — harness-bridge (live execution + promote-to-main)

- Status: **DRAFT / OPEN** — this is the gate. `promote-to-main` stays preview-only and the
  daemon stays on the dry-run fixture until this model is reviewed and the
  **Gate checklist (§7)** is fully satisfied and signed off (§8).
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
| T5 | **Information disclosure / Tampering** — path traversal (read/write outside repo) | `planFile`/slug containing `/` or `..` | `PLAN_FILE` = bare filename, `..` rejected, slug pattern has no separators | Low | Resolve plan files against a fixed allow-dir and assert the resolved path stays inside it |
| T6 | **Denial of service** — host hang / slot lockout | child fills stderr pipe; unbounded buffers; stuck slot; orphaned subprocess tree | **DONE** — stderr drained; SSE buffer bounded (`MAX_PENDING`); single-slot lock; `spawnHarness` deadline (`HARNESS_TIMEOUT_MS`, default 10 min) kills the whole **process group** (`detached` + `-pid`) SIGTERM→SIGKILL and settles only on `close` (slot held until the child truly exits → no overlap with the next run), rejecting `HarnessTimeoutError` so the daemon releases the slot + persists `failed` | Low | Done. |
| T7 | **Repudiation** — no record of what ran | — | **DONE** — append-only `audit` table written on every `spawnHarness` settle (argv + outcome + ts + exit code). Mandatory (the SQLite write always runs; `onAudit` only observes). **Never stores stdout/stderr or the error message** — only the error CLASS name (+ safe errno), since the message can embed the rejected value | Low | Done. |
| T8 | **SSRF** | client-supplied URL fetched server-side | none needed — no client input becomes an outbound URL | N/A | n/a |
| T9 | **Elevation via boundary leak** — non-allowed code imports the store impl / bridge | a new module bypasses the eslint denylist | import-boundary zones (denylist) | Low | Tighten the eslint boundary to an **allowlist** so only sanctioned files import `lib/store` impl / harness-bridge spawn |
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
- [ ] T4 — verified the browser-facing path never receives any env/secret; `ANTHROPIC_API_KEY` deletion enforced at process start.
- [ ] T5 — plan-file resolution constrained to a fixed directory with a containment assertion. (Provenance done — plan files are now minted; remaining: resolve the minted name under a fixed allow-dir and assert the resolved path stays inside it.)
- [x] T6 — `spawnHarness` has a **timeout + kill** (deadline → SIGTERM → SIGKILL, rejects `HarnessTimeoutError`); a hung child releases the slot via the daemon's catch/finally. Default 10 min, override `HARNESS_TIMEOUT_MS`.
- [x] T7 — **audit log** of every spawn (argv + outcome + ts + code, no secrets): append-only `audit` table in `persist.ts`, written by `spawnHarness` at every settle point (exit/timeout/error/refused/invalid-args), on by default.
- [ ] T9 — eslint import-boundary converted to an **allowlist**.
- [ ] TB-1 — Tailscale ACL reviewed; confirmed no public/LAN exposure.
- [ ] `harness.sh` emits **line-delimited JSON events** (the contract `parseHarnessLine` consumes) — without this, live wiring has no structured channel.
- [ ] This document reviewed and signed off (§8).

Until every box is checked: `ENABLE_PROMOTE_TO_MAIN` stays unset, and the daemon
producer stays on the dry-run fixture.

## 8. Sign-off

| Role | Name | Verdict | Date |
|------|------|---------|------|
| Security review | _open_ | — | — |
| Operator | _open_ | — | — |

**Decision:** OPEN. Live execution and promote-to-main mutation are **not** authorized.

---

_skipped: formal attack trees / DREAD scoring — STRIDE + the gate checklist is enough
at this scale; add quantitative scoring if the operator/reviewer set grows._
