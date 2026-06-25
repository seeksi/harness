# HARNESS — Handoff / Resume Point (2026-06-24)

Where the multi-lane work stands and exactly how to pick it back up. Read this +
`memory/harness-roadmap.md` (the canonical roadmap) to resume cold.

## TL;DR
The full roadmap is in `main` and **the per-lane isolation is proven live**. The only
thing between here and live 3-lane concurrency is an **operator auth bootstrap** + a flag
flip — no engineering left. Everything runs **safe today**: concurrency defaults to 1
(sequential, identical to before), and `HARNESS_LIVE=0` (dry-run).

## What's DONE (all in `main`, cross-reviewed)
| Item | Commit | Proof |
|---|---|---|
| Full pipeline live (agent build → gates → promote) | (earlier) | real run reached `main` |
| #15 Safe-agent sandbox (`lib/sandbox/` + `runAgentInSandbox`) | — | `conformance.sh` **13/13** on VPS |
| #15 provisioner + threat model + conformance | — | `deploy/tier3/{provision,conformance}.sh` |
| Observability panels (ToolRegistry/MemoryGauge/TaskLoop) | — | deployed, ⌘K |
| #16a multi-lane MACHINERY (concurrent capped builds, serial merge) | `7231488` | 62 daemon tests; **default `LANE_CONCURRENCY=1`** |
| #17a per-lane uid + deploy-owned worktree + **per-lane ACL** | `96b187f` | 249 tests; ACL leak found+closed in 2 cross-reviews |
| #17b N-user provisioner + cross-lane conformance | `8252ecb` | — |
| #17c LIVE isolation proof | (ran on VPS) | **`conformance-multilane.sh` 17/17 PASS** |

`main` HEAD at handoff: **`8252ecb`**.

## Live VPS state (`deploy@178.156.247.151`, tailnet `100.86.74.120:3000`)
- App: live, HTTP 200, dry-run. Flags: `ENABLE_AGENT_EXEC=1`, `ENABLE_PROMOTE_TO_MAIN=1`,
  **`HARNESS_LIVE=0`** (dry-run), `LANE_CONCURRENCY` unset → **default 1**.
- Lane users provisioned: `agent` (uid 1001, lane 0) + `agent-1..agent-4` (uid 995..992),
  all nologin, 0700 HOME, linger on. `acl` pkg installed; setfacl verified on the
  worktrees FS. Pooled sudoers Runas installed (`visudo` OK). Wrapper updated (per-lane
  500M default + `--slice`).
- **Cross-lane ACL isolation PROVEN**: sibling uids cannot read each other's worktree or
  agent-created files; `deploy` can read both. (17/17.)

## REMAINING — 17c-final (operator-gated; no engineering)
Do these in order, then concurrency can go live:

1. **Fix `agent-1`'s user manager** (its `systemd-run --user` scope wasn't ready at
   provision time — fail-closed, so safe, just non-functional for that lane). Run:
   ```
   ssh deploy@178.156.247.151 'uid=$(id -u agent-1); sudo loginctl enable-linger agent-1; sudo systemctl start "user@${uid}.service"; sleep 2; systemctl is-active "user@${uid}.service"; sudo -n -u agent-1 XDG_RUNTIME_DIR=/run/user/$uid systemd-run --user --scope -q -- true && echo "PASS: agent-1 scope works" || echo "STILL FAILING"'
   ```
   Expect `active` + `PASS`.

2. **Bootstrap each lane's Max-plan SESSION** (the one interactive step — keeps G5, no
   token in env). Two paths:
   - **Per-user login** (decided/clean): for each of `agent-1..agent-4`, log `claude` in
     under that user's HOME through the proxy. ~4 interactive logins.
   - **Copy the session** (faster — TEST first): copy `agent`'s already-authed `~/.claude`
     into each `agent-{i}` HOME, chown to that user, 0700. Each gets its OWN copy (no
     shared-session race, still no token in env). Validate with
     `sudo -u agent-1 -H claude --version` (or a tiny real run) — works only if the
     Max-plan OAuth session survives the copy. If it doesn't, fall back to per-user login.

3. **Re-validate**: `ssh deploy@178.156.247.151 'cd /opt/umbrella && sudo bash deploy/tier3/conformance-multilane.sh'` → expect 17/17.

4. **Raise concurrency** (RAM bound: per-lane 500M × N ≤ ~1.6G on the 2GB host → **N≤3**).
   Set `Environment=LANE_CONCURRENCY=3` in the live drop-in
   `/etc/systemd/system/umbrella.service.d/agent.conf`, `daemon-reload`, restart umbrella.
   Then flip `HARNESS_LIVE=1` only when you want a real run (flip back to 0 after).

5. **Watch a real multi-lane run** in the browser (⌘K → the panels). NOTE: `planRun` still
   emits ONE lane today — true brief→N-disjoint-lane DECOMPOSITION + cross-review-in-daemon
   gating are the next roadmap chunks (see `harness-roadmap.md` C-orig / task notes).

## How to resume in a fresh session
- Read `memory/harness-roadmap.md` (full state) + `memory/harness-goal.md` + this file.
- Process rule (standing): **council** for decisions (`claude-council:ask` / codex),
  **dev team** (`.claude/agents/`) for code, **Claude×Codex cross-review** on anything
  touching agent-exec/contract. Don't self-approve agent-exec or weaken egress/isolation.
- Deploy: `ssh deploy@178.156.247.151`, `cd /opt/umbrella && git reset --hard origin/main`,
  `npm run build` (in `web/`) + restart `umbrella` if app code changed.
- **Classifier note:** prod VPS state-changes (new users, sudoers, systemctl) get blocked
  by the auto-mode classifier unless you (a) explicitly authorize that specific action, or
  (b) add a Bash permission rule for `ssh deploy@178.156.247.151`. For one-offs, run the
  command yourself with a leading `!` in the prompt.

## Open tasks
- **#16 / #16a**: machinery DONE (committed). Concurrency gated on #17.
- **#17**: isolation DONE + proven; 17c-final (above) remains = operator auth + flip.
- Next roadmap chunks (not started): brief→N-lane decomposition; cross-review gating in the
  daemon; per-lane HOME aggregate cgroup (host-wide RAM cap — documented ceiling);
  observability "tool toggles / real-time approvals" + dynamic UI.
