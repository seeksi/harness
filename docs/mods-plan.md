# Claude Code mods — build plan

Committee: codex (gpt-5.5) + antigravity (Gemini 3.1 Pro), 2026-10-08.
Cache: `.claude/council-cache/council-1791484332.md`, `council-1791484440.md`.

## Decision

Build four, in this order. Each is a `tool.call` deny hook; none adds UI.

| # | mod | scope | prevents |
|---|-----|-------|----------|
| 1 | `trajectory-guard` | headless lanes (`--plugin-dir`) + interactive | agent loops/explosions burning budget before Gate D runs |
| 2 | `context-guard` | interactive orchestrator | fragile transcript-parsing hook; starts new work past 75% |
| 3 | `memory-guard` | interactive | hand-edits to memory-os JSON; secrets written to memory |
| 4 | `review-gate` | interactive orchestrator | merge/push to `integration`/`main` without a Gate-B PASS for HEAD |

Not building: GANTRY pane (UI, no safety value), `mem` typed tools (redundant with MCP server; zero-MCP risk in lanes), full DLP secret scanner (regex only, on memory-guard).

Doctrine (both vendors): a Bash-string deny is **behavioural correction, not a security boundary**. Real enforcement stays where it is: console merge path, server-side branch protection, fs perms, mod folder outside agent-writable paths. These mods are smoke alarms.

## Shared mechanics

- Layout: `mods/<name>/{.claude-plugin/plugin.json, hooks/hooks.json, hooks/register.ts, hooks/<name>.test.ts}` (+ `types/index.d.ts` when `$.state` is used). `mods/.claude-plugin/marketplace.json` makes the repo a marketplace; install = `/plugin install <name> --marketplace seeksi/harness`.
- Every guard hook ends `.catch(($, e, next) => next.called ? next(e) : { deny })` — a crashed guard denies, never passes. Exception: context-guard fails open (a usage read that throws must not brick every tool call; same non-blocking contract as the shell hook it replaces).
- Tests: `claude plugin test mods/<name>`; the test's `on` sits beneath the plugin, so it answers `session.usage`/`tool.call` as the engine would and asserts on `$.tool.call(...)`.
- Gates per mod: A `budget.py docs/mods-plan.jsonl`; B codex cross-review (diff + this file's section as spec); C `claude plugin validate` + `claude plugin test` + `tsc -p`; D `harness.sh trace <session>` on the build session.
- Headless loading (mod 1 only): the runtime copy lives at `~/.gantry/mods/trajectory-guard/` (console-owned, outside `HARNESS_REPO` and the worktrees dir; `install.sh` copies it there). `agent-runner.ts` hardcodes that path (no env override), realpaths it per build, throws `AgentExecError` if `isAgentWritablePath()` or its `plugin.json` name ≠ `trajectory-guard`, and appends `--plugin-dir <abs>`. Missing ⇒ `console.warn` and run unguarded (post-hoc Gate D still gates) rather than refuse every run on a box that hasn't run `install.sh` — deviation from the reviewed plan, accepted because the mod is early warning, not the boundary. Touches `console/lib/sandbox/**` → cross-review rule 5 applies: the mod registers no tools, no MCP, reads nothing memory-related. Reviewer must confirm.

## 1. trajectory-guard

Hook: `on('tool.call', hook)` (all tools). State in `$.state.trajectory`: `{ total, last, run }`.
Key = `tool + JSON.stringify(input)` (exact match, same as `trace-check.py`'s sig). Thresholds copied verbatim: `LOOP_RUN=3`, `MAX_CALLS=200`. THRASH is not live-denied (subjective; stays in Gate D).
Deny text names the rule and tells the agent what to change. Status line shows `calls N` interactively.
Failure mode: false deny on legit repeated `npm test`. Accepted: 3 byte-identical calls in a row is the agreed Gate-D definition; same rule, earlier.
Test: two identical `Read` calls pass, third denied; 200 distinct calls pass, 201st denied; the crashed-guard path denies.
Wiring: `--plugin-dir` in `agent-runner.ts` + containment check + 1 regression test (path inside worktree throws). `install.sh` copies `mods/trajectory-guard` → `~/.gantry/mods/` and is the first step of the live smoke (stale runtime copy = stale guard); the smoke's console log must show the mod's load line. Live smoke on the c2 throwaway (recipe in HANDOFF.md).

## 2. context-guard

Hook: `on('tool.call', hook)` reads `$.session.usage()` → fill = `context.percent ?? (context.tokens && context.window ? 100 * tokens / window : 0)`, `cost.usd`.
Scale: whole percent 0–100 everywhere (the API's `percent` is 0–100; the fallback computes the same). Thresholds from `userConfig` `soft`/`hard` as whole percents, defaults 60/75; `CONTEXT_GUARD_*` env no longer read.
Policy mirrors `context-guard.py`: ≥soft → one-time `$.ui.toast` + status "checkpoint NOTES.md"; ≥hard → deny tool calls that start work: `Agent`, and `Bash` whose command matches the regex `/gantry\s+run|harness\.sh\s+wt-new|\bwt-new\b|\bclaude\s+(-p|--print)\b|\bcodex\s+exec\b/` (unanchored, so `bash /abs/harness.sh wt-new` is caught); allow everything else so HANDOFF.md/commit still work. Status line: `ctx 62% · $1.43`.
Failure mode: denying the checkpoint itself. Mitigated by allow-listing (deny is a short pattern list, not everything).
Test: usage answered at 76% → `Agent` denied, `Bash bash /x/harness.sh wt-new foo` denied, `Write HANDOFF.md` and `Bash git commit` allowed; usage answered with `percent` absent and `tokens=800, window=1000` → same denies; `Bash claude -p "x"` and `Bash claude --print x` denied; at 50% nothing denied, no toast.
Retire: `.claude/settings.json` PostToolUse entry for `context-guard.py` once the mod has run one real session (keep the script one release).

## 3. memory-guard

Hook: `on('tool.call', { tool: 'Edit' | 'Write' | 'MultiEdit' })` — resolve `file_path` against cwd, realpath the nearest **existing** ancestor (`$.fs.stat(p, { resolve: true })` walking up), append the remainder; deny under `<memory-os>/memory_layer/{projects,global}/` with "use `mem propose`". Root from `userConfig.memoryRoot`, default `/home/alter/claude/memory-os`.
Bash, in this order: (1) if the text contains a protected root path AND any write token (`>`, `>>`, `|\s*tee`, `sed -i`, `mv `, `cp `, `rm `, `-delete`, `-exec`, `open(`, `write_text`, `git (checkout|restore|clean|reset|apply|stash)`) → deny; (2) else if it starts with `mem ` or contains `engine/cli.py` or its first word is a reader (`cat|less|head|tail|jq|grep|rg|ls|find|diff|git`) → pass; (3) else if it contains a protected root path → deny. A protected path "appears" when named literally OR when the session cwd is under the memory root and the text names `memory_layer/`, `projects/` or `global/` relatively. The `mem`/`cli.py` allowlist is the whole CLI on purpose: it is the audited write path (`propose`) plus derived-view writers (`index sync`, `render`); gating its subcommands would re-implement its own policy. Python/node one-liners that build the path without naming it are not caught — documented; fs perms are the real boundary.
Secret regex on `Write.content`, `Edit.new_string`, every `MultiEdit.edits[].new_string`, for targets under `memory_layer/**` only (private key headers, `sk-`, `AKIA`, `ghp_`, `xox[bp]-`, 12-word seed) — deny with the pattern name, never the match.
Test: Edit `projects/foo/decisions.json` denied; Write `README.md` allowed; Write to a not-yet-existing `projects/new/x.json` denied (ancestor resolution); Bash `python3 .../cli.py propose ...` allowed; Bash `cat x > .../global/foo.json` denied; Bash `python3 -c 'open("<root>/memory_layer/global/x.json","w")'` denied (path named); Write under `memory_layer/` with `-----BEGIN PRIVATE KEY-----` denied; Edit with `new_string` containing `AKIA…` denied; MultiEdit same.

## 4. review-gate

Scope: **merges only.** The merge is where unreviewed code enters `integration`/`main`; pushes of those branches are already operator-gated (promote go/no-go, server-side protection) and would need merge-commit bookkeeping the mod can't do cheaply.
Artifact: `~/.gantry/reviews/<sha>.json` `{ "verdict": "PASS"|"BLOCK", "head": sha, "at": iso }` — operator-owned, outside every repo and worktree, so a lane agent (which runs as the daemon user with a worktree cwd) cannot forge it; shared by every worktree of every repo (a SHA is global). Writer: `/review-record PASS|BLOCK [branch]` registered in `register.ts` (`$.command.register` in `session.start`, answered by a `command.run` hook) stamping `git rev-parse <branch|HEAD>`; the cross-review skill's step 5 gains one line: run it.
Hook: `on('tool.call', { tool: 'Bash' })`. Gated commands, subcommand matched on a whitespace/end boundary so `merge-base`, `merge-tree` pass:
- `git (-C <dir> )?merge <src>` — source SHA = `rev-parse <src>` in `<dir>` or cwd; denied unless `reviews/<srcSha>.json` is PASS. Gated whenever the current branch of that dir is `main` or `integration`; on any other branch, pass (lane-internal merges aren't the gate). Flags like `--no-ff`, `-m msg` are skipped to find `<src>`; `--abort|--continue|--quit`, `--dry-run` pass.
- `harness.sh integ-merge <slug>` — source = `feat/<slug>`, same check.
- `git pull` while on `main`/`integration` is denied outright (it is a merge the gate can't inspect; fetch + merge instead).
- Compound commands (`&&`, `;`, `||`, newline, `cd `, `git checkout|switch` earlier in the text) containing a raw `git merge` are denied outright — the hook samples branch/cwd before the shell runs, so it cannot know the branch at merge time. Message: run the merge as its own command or via `harness.sh integ-merge`.
Failure mode: old-SHA artifact unlocking a new lane head — covered by `head` match; a spoofed artifact is accepted (smoke alarm, by design); multi-source octopus merges are denied outright (unsupported).
Test (cwd a temp repo with `integration` checked out and `feat/x` one commit ahead): `git merge feat/x` denied; allowed after `/review-record PASS feat/x`; a new commit on `feat/x` → denied again; `git merge-base main HEAD` allowed; on branch `feat/x`, `git merge main` allowed; `git -C <repo> merge feat/x` denied from another cwd.
Harness follow-up (not a mod, separate PR): `harness.sh integ-merge` reads the same artifact — that is the real gate.

## Status (2026-10-08)

All four built on `feat/mods`, each: Gate A (batch est. $1.40/$5), Gate B codex PASS, Gate C (`claude plugin validate` + `claude plugin test` + tsc 0; console 81/81, eslint, tsc 11 = baseline, install.test.sh 29/0). Gate D on the orchestrator session flagged THRASH (Bash 87% of calls — research session, not a lane; reported, not blocking). Installed at user scope from the folder marketplace `harness-mods` (`claude plugin list` → "Read from: mods/<name>"); runtime copy at `~/.gantry/mods/trajectory-guard`.
Live headless smoke (2026-10-08, run `2230c50dd8bfe98d59aaa352` on a fresh c2 throwaway): the lane spawned with the runtime `--plugin-dir` (no "not installed" warning; the only omission path), built `src/hello.test.js`, committed, trace written; a direct `claude -p --plugin-dir ~/.gantry/mods/trajectory-guard --debug-file` shows `Loaded inline plugin from path: trajectory-guard`. The run then stopped at Gate B's TDD-evidence rule (no `tdd-run red` log committed) — a pre-existing harness gate the headless agent does not yet satisfy, unrelated to the mod.
Open: `harness.sh integ-merge` honouring `~/.gantry/reviews/<sha>.json` (the real gate, separate PR); retire the `context-guard.py` PostToolUse entry after one real session; push `feat/mods` on operator say-so.

## Order and stop rule

1 → 2 → 3 → 4. Each mod: write → gates A–D → commit on `feat/mods` → next. Any BLOCK halts that mod only. No push without operator say-so. Promote to `main` is the one human go/no-go.
