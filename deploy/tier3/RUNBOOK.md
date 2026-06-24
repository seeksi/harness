# Tier-3 Provisioning Runbook — enable `ENABLE_AGENT_EXEC=1`

DRAFT FOR OPERATOR REVIEW. Nothing here has been run. This runbook provisions the
hardened host so the headless build agent can run, satisfying the §6 gate checklist in
`docs/security/threat-model-agent-exec.md`. Each step maps to a gate ID.

> The author did NOT touch the VPS and did NOT commit. You execute this after sign-off.

## Deploy facts (given)

- Host `ubuntu-2gb-ash-1`, Ubuntu 26.04, Node 22. Login `deploy@` with NOPASSWD sudo.
- Repo `/opt/umbrella` (`HARNESS_REPO`); app `/opt/umbrella/web`.
- Worktrees → `/opt/umbrella.worktrees/<slug>` (sibling, per `wt.sh` / agent-bridge).
- Unit `/etc/systemd/system/umbrella.service` (Type=simple, User=deploy,
  NoNewPrivileges=yes, PrivateTmp=yes, ProtectSystem=full).
- Auth is Max-plan subscription session — NO `ANTHROPIC_API_KEY`. The login is a MANUAL
  operator action (below); never scripted, never a secret in a file.

## Required env keys (surfaced; none are secrets)

Set by the systemd drop-in (`umbrella-agent.conf`), read by `agent-bridge.ts`:
`AGENT_USER`, `AGENT_CLI_PATH`, `AGENT_SUDO_PATH`, `AGENT_HOME`, `AGENT_PATH`,
`AGENT_TIMEOUT_MS`, `HARNESS_LIVE`. Cutover-only (kept commented): `ENABLE_AGENT_EXEC`,
`ENABLE_PROMOTE_TO_MAIN`. No `ANTHROPIC_API_KEY` anywhere (Max-plan).

---

## Prerequisites

1. Tier-2 complete: a live non-agent promote validated, daemon healthy on `HARNESS_LIVE`.
2. The threat-model §6 boxes that are operator-action are about to be satisfied by this
   runbook; §7 sign-off is the LAST step before cutover.
3. Copy this `deploy/tier3/` dir to the VPS (e.g. it ships in `/opt/umbrella/deploy/`).
4. `chmod +x` the two scripts after copying.
5. Install packages: `tinyproxy` (egress proxy, Step 4). `systemd-run` ships with systemd
   (Step 2 cgroup caps) — no install needed.

---

## Run order

### Step 1 — provision the agent user  → G1
```
sudo bash /opt/umbrella/deploy/tier3/01-provision-agent-user.sh
```
Creates `agent` (system, nologin, HOME `/opt/umbrella/agent-home`), `chown`s the
worktrees dir to `agent:deploy` (2775), keeps the repo read-only to agent, and ENABLES
LINGER so the agent has a persistent `systemd --user` manager + `/run/user/<uid>` (needed
for the G6 cgroup scope in the wrapper).

VERIFY:
```
id agent                                  # exists, non-root uid
stat -c '%U:%G %a' /opt/umbrella.worktrees   # agent:deploy 2775
stat -c '%U %a' /opt/umbrella/agent-home     # agent 700
sudo -u agent -H test -w /opt/umbrella && echo "BAD: agent can write repo" || echo "OK: repo read-only to agent"
# Linger + user manager (so the wrapper's cgroup scope works, else it FAILS CLOSED):
loginctl show-user agent -p Linger          # Linger=yes
test -d /run/user/$(id -u agent) && echo "OK: XDG_RUNTIME_DIR present"
sudo -u agent XDG_RUNTIME_DIR=/run/user/$(id -u agent) systemd-run --user --scope -q -- true \
  && echo "OK: agent can create a cgroup scope (G6)" || echo "BAD: no user scope — wrapper will refuse"
```

### Step 2 — install the wrapper  → G6
```
sudo install -m 0755 -o root -g root \
  /opt/umbrella/deploy/tier3/agent-exec-wrapper.sh /opt/umbrella/deploy/agent-exec-wrapper.sh
```
(Keep it root-owned, NOT agent-writable.)

The wrapper applies per-process ulimits AND launches claude inside a transient cgroup
scope (`systemd-run --user --scope` with MemoryMax=1500M, MemorySwapMax=0, TasksMax=256,
CPUQuota=180%) for an AGGREGATE cap. If `systemd-run --user --scope` is unavailable
(missing binary, no `/run/user/<uid>`, or the probe scope fails) the wrapper EXITS 78
(EX_CONFIG) and never runs claude uncapped — fail-closed.

VERIFY (after Step 5 installs claude):
```
stat -c '%U %a' /opt/umbrella/deploy/agent-exec-wrapper.sh   # root 755
# Fail-closed proof: with the user manager unreachable, the wrapper must refuse, not run.
sudo -u agent XDG_RUNTIME_DIR=/nonexistent /opt/umbrella/deploy/agent-exec-wrapper.sh --version \
  ; echo "exit=$?  (expect 78 = fail-closed, NOT a claude version)"
```

### Step 3 — install the sudoers fragment  → G1
```
sudo install -m 0440 -o root -g root \
  /opt/umbrella/deploy/tier3/sudoers.d-umbrella-agent /etc/sudoers.d/umbrella-agent
sudo visudo -cf /etc/sudoers.d/umbrella-agent      # MUST print "... parsed OK"
sudo visudo -c                                     # whole tree OK
```

### Step 4 — install the egress proxy + nft backstop  → G4
The FQDN allowlist lives in a loopback forward proxy; nft only prevents the agent from
bypassing it. Two parts.

**4a. The proxy** (its own low-priv user, loopback-only, FQDN allowlist):
```
sudo apt-get install -y tinyproxy
sudo useradd --system --no-create-home --shell /usr/sbin/nologin tinyproxy-agent 2>/dev/null || true
sudo install -d -o tinyproxy-agent -g tinyproxy-agent -m 0750 /var/log/tinyproxy
sudo install -m 0644 -o root -g root \
  /opt/umbrella/deploy/tier3/egress-proxy/tinyproxy.conf        /etc/tinyproxy/agent-proxy.conf
sudo install -m 0644 -o root -g root \
  /opt/umbrella/deploy/tier3/egress-proxy/anthropic-allow.filter /etc/tinyproxy/anthropic-allow.filter
sudo install -m 0644 -o root -g root \
  /opt/umbrella/deploy/tier3/egress-proxy/umbrella-egress-proxy.service \
  /etc/systemd/system/umbrella-egress-proxy.service
# AppArmor: Ubuntu's tinyproxy profile confines it to DEFAULT paths and DENIES our custom
# config/filter/log (symptom: "Could not open config file" even as root). Add the override.
sudo install -m 0644 -o root -g root \
  /opt/umbrella/deploy/tier3/egress-proxy/apparmor-local-tinyproxy /etc/apparmor.d/local/tinyproxy
sudo apparmor_parser -r /etc/apparmor.d/tinyproxy
sudo systemctl daemon-reload
sudo systemctl enable --now umbrella-egress-proxy
sudo ss -ltnp | grep 127.0.0.1:3128       # listening on loopback only
```
Notes (from the first real run): the binary is `/usr/bin/tinyproxy` (not `/usr/sbin`), this
tinyproxy (1.11) has no config-test flag, and its config takes **no inline `#` comments**.
Those are already baked into the committed unit/config — listed here only so the symptoms
("status=203/EXEC", "Syntax error on line N") are recognizable.
Allowed hostnames (in `anthropic-allow.filter`): `api.anthropic.com` (and any
`*.anthropic.com` sub-host). Everything else is denied by `FilterDefaultDeny Yes`. Do NOT
widen to telemetry hosts unless the CLI hard-fails without them (see GAPS.md G4).

**4b. The nft backstop** (agent uid → proxy only; deny all direct egress incl. DNS):
```
sudo nft -f /opt/umbrella/deploy/tier3/agent-egress.nft
sudo nft list table inet agent_egress
```
Persist across reboot via your nftables include (`/etc/nftables.conf` `include`, or copy
into `/etc/nftables.d/`).

VERIFY egress (run AFTER claude is installed in Step 5; the agent uses the proxy via the
env the wrapper sets, so test through the wrapper / with the proxy env):
```
# Allowed: through the proxy, Anthropic resolves+connects.
sudo -u agent -H HTTPS_PROXY=http://127.0.0.1:3128 \
  curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/   # connects (4xx is fine)
# Denied by the proxy allowlist: a non-Anthropic host via the proxy must be refused.
sudo -u agent -H HTTPS_PROXY=http://127.0.0.1:3128 \
  curl -sS --max-time 5 https://example.com/ && echo "BAD: proxy allowed it" || echo "OK: proxy denied"
# Denied by nft: DIRECT egress (no proxy) from the agent uid must be dropped.
sudo -u agent -H NO_PROXY='*' curl -sS --max-time 5 https://example.com/ \
  && echo "BAD: agent bypassed proxy" || echo "OK: nft blocked direct egress"
# Direct DNS from the agent is also blocked (proxy resolves names):
sudo -u agent nslookup -timeout=3 example.com 2>&1 | grep -qi 'timed out\|connection' \
  && echo "OK: direct DNS blocked" || echo "CHECK: agent resolved DNS directly"
# deploy is unaffected:
curl -sS --max-time 5 -o /dev/null https://example.com/ && echo "OK: deploy egress normal"
```

### Step 5 — Max-plan auth (MANUAL operator action)  → G5 + "Max-plan auth set up"
Install the real `claude` CLI to the path the wrapper expects
(`/usr/local/bin/claude`; adjust `REAL_CLAUDE` in the wrapper if your install prefix
differs), then log in AS the agent user so the session is stored under `AGENT_HOME`:
```
# install claude per its docs (npm -g or the installer) to /usr/local/bin/claude
sudo -u agent -H /usr/local/bin/claude          # interactive: complete the Max-plan login
# ^ session is written to /opt/umbrella/agent-home/.claude (uid agent, 0700)
```
This is a HUMAN step: the subscription login is interactive and the credential must
NEVER land in the daemon/browser path, a script, or git. It lives only under the agent
user's private HOME.

VERIFY auth + wrapper end-to-end (still pre-cutover; spawnAgent is off, this is a direct
sudo test of exactly the invocation shape agent-bridge uses):
```
sudo -n -H -u agent -- /opt/umbrella/deploy/agent-exec-wrapper.sh --version   # prints claude version
# ^ this exercises the FULL path: sudo drop → wrapper → ulimits → systemd-run --user
#   --scope (cgroup caps) → real claude. A version string here means cgroup+proxy env are
#   all in place. If it exits 78, the user scope is unavailable — fix linger (Step 1).
ls -ld /opt/umbrella/agent-home/.claude        # owned by agent, 700
```

### Step 6 — install the systemd drop-in (env, flags still OFF)  → wiring
```
sudo install -d /etc/systemd/system/umbrella.service.d
sudo install -m 0644 -o root -g root \
  /opt/umbrella/deploy/tier3/umbrella-agent.conf /etc/systemd/system/umbrella.service.d/agent.conf
sudo systemctl daemon-reload
sudo systemctl restart umbrella
```
VERIFY env is present and flags are NOT yet set:
```
systemctl show umbrella -p Environment        # shows AGENT_*, HARNESS_LIVE=1;
                                              # NO ENABLE_AGENT_EXEC / ENABLE_PROMOTE_TO_MAIN
```

### Step 7 — credential-isolation confirmation  → G5
Confirm no secret reaches the browser/audit path. `assertNoCredential` guards the
SSE/JSON boundary; there should be no `ANTHROPIC_API_KEY` in env, and the audit records
carry only `lane/model/session/outcome`.
```
systemctl show umbrella -p Environment | grep -i anthropic && echo "BAD" || echo "OK: no API key in unit"
# After a run (Step 8), spot-check the audit holds no prompt/token:
sqlite3 /opt/umbrella/web/data/umbrella.db "select cmd, argv, outcome from audit order by ts desc limit 5;"
```

---

## CUTOVER  → flips ENABLE_AGENT_EXEC (G1..G6 active) + ENABLE_PROMOTE_TO_MAIN (G8)

Do this ONLY after Steps 1-7 verify clean AND §7 sign-off is recorded.

1. Edit `/etc/systemd/system/umbrella.service.d/agent.conf`, UNCOMMENT:
   ```
   Environment=ENABLE_AGENT_EXEC=1
   Environment=ENABLE_PROMOTE_TO_MAIN=1
   ```
   (You may enable AGENT_EXEC first, watch a lane build→merge WITHOUT promote, then
   enable promote separately — recommended for the first run.)
2. Apply:
   ```
   sudo systemctl daemon-reload && sudo systemctl restart umbrella
   systemctl show umbrella -p Environment | grep ENABLE     # both =1
   ```
3. Submit a TINY task (e.g. "add a one-line comment to README"). Watch one lane:
   - `wt-new` creates `/opt/umbrella.worktrees/<slug>` (Gate A budget passed first),
   - the agent builds + commits in the worktree (runs as `agent` via sudo wrapper),
   - `wt-verify` (Gate B: committed + clean),
   - trace relocated + `trace` gate (Gate D),
   - `integ-merge` (Gate C),
   - human diff review, then `promote` (Gate G8 — review the diff BEFORE approving).
4. Confirm the agent ran as `agent` not `deploy`:
   ```
   sudo journalctl -u umbrella --since "5 min ago" | grep -i sudo
   ps -eo user,cmd | grep claude     # during the run: USER=agent
   ```

---

## ROLLBACK

Disable agent exec immediately (re-comment the flags):
```
sudo sed -i 's/^Environment=ENABLE_AGENT_EXEC=1/#Environment=ENABLE_AGENT_EXEC=1/' \
  /etc/systemd/system/umbrella.service.d/agent.conf
sudo sed -i 's/^Environment=ENABLE_PROMOTE_TO_MAIN=1/#Environment=ENABLE_PROMOTE_TO_MAIN=1/' \
  /etc/systemd/system/umbrella.service.d/agent.conf
sudo systemctl daemon-reload && sudo systemctl restart umbrella
```
`spawnAgent` then refuses (default-off gate) and `promote` refuses. The agent user,
sudoers rule, egress proxy, and nft backstop can stay in place (inert without the flag).
To fully tear down: remove `/etc/sudoers.d/umbrella-agent`; flush `nft delete table inet
agent_egress`; `systemctl disable --now umbrella-egress-proxy` (+ remove its unit/config
and the `tinyproxy-agent` user); `loginctl disable-linger agent`; and `userdel -r agent`
(this deletes the Max-plan session — re-auth needed).

---

## Gate ID → step map

| §6 gate | Step |
|---|---|
| G1 (dedicated low-priv user, FS-confined) | 1, 3 |
| G1/G9 (tool allowlist) | code default (`Read,Edit,Write,Grep,Glob`, no Bash) — see GAPS.md, OPERATOR DECISION |
| G4 (egress: FQDN proxy + nft bypass-block) | 4a (proxy), 4b (nft backstop) |
| G5 (session outside agent-readable-by-others FS; absent from env/audit/browser) | 1, 5, 7 |
| G6 (per-agent resource limits: cgroup scope + ulimit) | 1 (linger), 2 (wrapper cgroup+ulimit) + AGENT_TIMEOUT_MS in 6 |
| G6 trace / G7 trace collection | already code-done (daemon relocates + Gate D) |
| G8 (promote default-off + human diff review) | cutover step 3, ROLLBACK |
| Max-plan auth | 5 |
| §7 sign-off | required before CUTOVER |
