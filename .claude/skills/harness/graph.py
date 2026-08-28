#!/usr/bin/env python3
"""Graph engine for the agent harness.

Owns the execution topology: explicit nodes and edges control what runs next,
what context each node may touch, and which cycles are legal (with visit caps).
The model never schedules itself — it asks `next`, executes exactly one node's
payload, then reports the outcome via `advance`. Off-graph moves are refused.

State lives in GRAPH.json at the target repo root (volatile, like the old
NOTES.status.json which this supersedes — along with NOTES.loop.json).

Usage:
  graph.py init <subtasks.json>   materialize the run graph from the decomposition
  graph.py next                   print the frontier: ready nodes as JSON lines
  graph.py advance <node> <outcome>  record a node's outcome; fire its edges
  graph.py resume "<note>"        clear a gate-failure HALT after fixing the cause;
                                  re-arms the halted node for a retry (its visit
                                  cap still applies — max_visits is the ceiling)
  graph.py status                 one-line summary + frontier

Semantics:
  - A node is READY when its join is satisfied: "any" = at least one inbound
    edge has fired since its last visit; "all" = every distinct inbound edge
    has fired. Roots are ready at visits==0.
  - advance refuses: a halted graph, a non-ready node, an undeclared outcome,
    a visit past the node's max_visits, or a step past the graph's max_steps.
    Refusal = exit 1 with the reason on stderr.
  - An outcome with NO matching outbound edge on a node that HAS outbound
    edges HALTS the graph (that is how gate failures stop the run). A node
    with no outbound edges at all is terminal — its ok is completion.
  - Firing an edge into a done node re-arms it (declared cycles re-run it).

Exit codes: 0 ok/continue; 1 refused or halted; 2 usage.
"""
import json
import subprocess
import sys

MAX_STEPS = 100


def repo_root():
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True).strip()
    except subprocess.CalledProcessError:
        sys.exit("graph: not in a git repo")


def gpath():
    return repo_root() + "/GRAPH.json"


def load():
    try:
        with open(gpath()) as f:
            return json.load(f)
    except FileNotFoundError:
        sys.exit("graph: no GRAPH.json — run `graph.py init <subtasks.json>` first")


def save(g):
    with open(gpath(), "w") as f:
        json.dump(g, f, indent=1)


def toposort(subs):
    order, remaining = [], [s["slug"] for s in subs]
    deps = {s["slug"]: set(s.get("deps", [])) for s in subs}
    unknown = set().union(*deps.values()) - set(remaining) if deps else set()
    if unknown:
        sys.exit(f"graph: unknown deps: {', '.join(sorted(unknown))}")
    while remaining:
        pick = next((s for s in remaining if deps[s] <= set(order)), None)
        if pick is None:
            sys.exit("graph: dependency cycle among subtasks: " + ", ".join(remaining))
        order.append(pick)
        remaining.remove(pick)
    return order


def build_graph(sub):
    nodes, edges = {}, []

    def node(nid, ntype, payload, outcomes=("ok",), context=None, join="any",
             max_visits=1):
        nodes[nid] = {"id": nid, "type": ntype, "payload": payload,
                      "outcomes": list(outcomes), "context": context or [],
                      "join": join, "max_visits": max_visits,
                      "state": "pending", "visits": 0, "armed": []}

    def edge(f, on, t):
        edges.append({"from": f, "on": on, "to": t})

    subs = sub["subtasks"]
    node("route_budget", "model+script",
         "write plan.jsonl from NOTES.md + route.py tiers, then: harness.sh budget plan.jsonl "
         "(Gate A — exit 1 = outcome fail)",
         ("ok", "fail"), context=["NOTES.md", "plan.jsonl"], max_visits=2)
    for s in subs:
        g, tier = s["slug"], s.get("tier", "default")
        ctx = [f"NOTES.{g}.md", f"worktree:{g}"]
        node(f"build.{g}", "model",
             f"harness.sh wt-new {g}; TDD in the worktree on the routed tier ({tier}): "
             f"1) write the failing test for NOTES.{g}.md's acceptance check, "
             f"2) harness.sh tdd-run {g} red -- <test cmd> (must fail), "
             f"3) implement the spec, 4) harness.sh tdd-run {g} green -- <test cmd> "
             f"(must pass). Docs/config-only lane: write the reason to "
             f".harness/tdd/{g}.skip instead",
             ("ok",), context=ctx, max_visits=2)
        node(f"commit.{g}", "script", f"harness.sh wt-commit {g}", ("ok",),
             max_visits=4)
        node(f"verify.{g}", "script",
             f"harness.sh wt-verify {g} (exit 1 = outcome fail)",
             ("ok", "fail"), max_visits=4)
        node(f"review.{g}", "model",
             f"cross-review the worktree diff — Codex gets ONLY the diff + the one-line "
             f"spec from NOTES.{g}.md, never your reasoning; strict-biased reconcile",
             ("pass", "block"), context=ctx, max_visits=4)
        node(f"fix.{g}", "model",
             f"fix the BLOCK findings in the {g} worktree (Read the files first — the "
             f"builder's edits are not in your context)",
             ("ok",), context=ctx, max_visits=3)
        edge("route_budget", "ok", f"build.{g}")
        edge(f"build.{g}", "ok", f"commit.{g}")
        edge(f"commit.{g}", "ok", f"verify.{g}")
        edge(f"verify.{g}", "ok", f"review.{g}")
        edge(f"verify.{g}", "fail", f"build.{g}")  # no-op agent: one rebuild
        edge(f"review.{g}", "block", f"fix.{g}")   # declared cycle, capped by fix visits
        edge(f"fix.{g}", "ok", f"commit.{g}")

    node("integ_start", "script", "harness.sh integ-start", ("ok",), join="all")
    for s in subs:
        edge(f"review.{s['slug']}", "pass", "integ_start")

    prev, prev_on = "integ_start", "ok"
    for g in toposort(subs):
        node(f"merge.{g}", "script",
             f"harness.sh integ-merge {g} (conflict stops the merge = outcome conflict)",
             ("ok", "conflict"), max_visits=3)
        node(f"suite.{g}", "model",
             "run the FULL test suite on integration (Gate C — red = outcome fail)",
             ("ok", "fail"), max_visits=3)
        edge(prev, prev_on, f"merge.{g}")
        edge(f"merge.{g}", "ok", f"suite.{g}")
        prev, prev_on = f"suite.{g}", "ok"

    node("eval_trace", "model+script",
         "on integration: regression (HARD) + planning/judge (HARD) + capability (soft) "
         "evals, then harness.sh trace <session> (Gate D — any HARD red or trace exit 1 "
         "= outcome fail)",
         ("ok", "fail"), max_visits=3)
    edge(prev, prev_on, "eval_trace")
    node("promote_gate", "human",
         "ask the human for the go/no-go — the ONLY human checkpoint; never advance "
         "'approved' without an explicit human yes",
         ("approved", "rejected"))
    edge("eval_trace", "ok", "promote_gate")
    node("promote", "script", "harness.sh promote", ("ok", "fail"), max_visits=2)
    edge("promote_gate", "approved", "promote")
    node("account_clean", "script",
         "note actual cost vs the plan.jsonl estimate (read /cost); harness.sh clean",
         ("ok",))
    edge("promote", "ok", "account_clean")

    return {"task": sub.get("task", ""), "nodes": nodes, "edges": edges,
            "steps": 0, "max_steps": MAX_STEPS, "halted": ""}


def inbound(g, nid):
    return [e for e in g["edges"] if e["to"] == nid]


def outbound(g, nid):
    return [e for e in g["edges"] if e["from"] == nid]


def is_ready(g, n):
    if g["halted"]:
        return False
    inb = inbound(g, n["id"])
    if not inb:  # root
        return n["visits"] == 0
    if n["state"] == "done" and not n["armed"]:
        return False
    keys = {f"{e['from']}:{e['on']}" for e in inb}
    armed = set(n["armed"])
    return keys <= armed if n["join"] == "all" else bool(armed)


def frontier(g):
    return [n for n in g["nodes"].values() if is_ready(g, n)]


def print_frontier(g):
    for n in frontier(g):
        print(json.dumps({k: n[k] for k in
                          ("id", "type", "payload", "context", "outcomes", "visits")}))


def cmd_init(argv):
    if len(argv) < 1:
        sys.exit("usage: graph.py init <subtasks.json>")
    with open(argv[0]) as f:
        sub = json.load(f)
    g = build_graph(sub)
    save(g)
    print(f"graph: {len(g['nodes'])} nodes, {len(g['edges'])} edges -> {gpath()}",
          file=sys.stderr)
    print_frontier(g)


def cmd_next():
    g = load()
    if g["halted"]:
        print(f"graph: HALTED — {g['halted']}", file=sys.stderr)
        sys.exit(1)
    f = frontier(g)
    if not f:
        term = g["nodes"]["account_clean"]
        if term["state"] == "done":
            print("graph: COMPLETE — all nodes terminal", file=sys.stderr)
        else:
            print("graph: no ready nodes and not complete — inspect GRAPH.json",
                  file=sys.stderr)
            sys.exit(1)
    print_frontier(g)


def cmd_advance(argv):
    if len(argv) < 2:
        sys.exit("usage: graph.py advance <node> <outcome>")
    nid, outcome = argv[0], argv[1]
    g = load()
    if g["halted"]:
        sys.exit(f"graph: refused — graph is halted ({g['halted']})")
    n = g["nodes"].get(nid)
    if n is None:
        sys.exit(f"graph: refused — no such node '{nid}'")
    if not is_ready(g, n):
        sys.exit(f"graph: refused — '{nid}' is not on the frontier (off-graph move)")
    if outcome not in n["outcomes"]:
        sys.exit(f"graph: refused — '{outcome}' not a declared outcome of '{nid}' "
                 f"(declared: {', '.join(n['outcomes'])})")
    if n["visits"] + 1 > n["max_visits"]:
        g["halted"] = f"{nid}: exceeded max_visits={n['max_visits']} (cycle cap)"
        save(g)
        sys.exit(f"graph: HALTED — {g['halted']}")
    if g["steps"] + 1 > g["max_steps"]:
        g["halted"] = f"max_steps={g['max_steps']} exceeded"
        save(g)
        sys.exit(f"graph: HALTED — {g['halted']}")

    n["visits"] += 1
    n["state"] = "done"
    n["armed"] = []
    g["steps"] += 1

    fired = [e for e in outbound(g, nid) if e["on"] == outcome]
    out_all = outbound(g, nid)
    if out_all and not fired:
        g["halted"] = f"{nid}: outcome '{outcome}' has no edge — gate failure"
        g["halted_node"] = nid
        save(g)
        print(f"graph: HALTED — {g['halted']}", file=sys.stderr)
        sys.exit(1)
    for e in fired:
        t = g["nodes"][e["to"]]
        key = f"{e['from']}:{e['on']}"
        if key not in t["armed"]:
            t["armed"].append(key)
        if t["state"] == "done":
            t["state"] = "pending"  # cycle re-arm
    save(g)
    print(f"graph: {nid} -> {outcome} (step {g['steps']})", file=sys.stderr)
    print_frontier(g)


def cmd_resume(argv):
    g = load()
    if not g["halted"]:
        sys.exit("graph: nothing to resume — graph is not halted")
    nid = g.get("halted_node", "")
    if not nid:
        sys.exit(f"graph: cannot resume '{g['halted']}' — only gate-failure halts "
                 "are resumable (visit/step caps need a human edit of GRAPH.json)")
    n = g["nodes"][nid]
    note = argv[0] if argv else "manual"
    n["state"] = "pending"
    if "resume:manual" not in n["armed"]:
        n["armed"].append("resume:manual")
    g["halted"] = ""
    g["halted_node"] = ""
    save(g)
    print(f"graph: resumed at {nid} ({note}) — visits {n['visits']}/{n['max_visits']}",
          file=sys.stderr)
    print_frontier(g)


def cmd_status():
    g = load()
    states = {}
    for n in g["nodes"].values():
        states[n["state"]] = states.get(n["state"], 0) + 1
    flags = f" HALTED: {g['halted']}" if g["halted"] else ""
    done = g["nodes"]["account_clean"]["state"] == "done"
    print(f"graph: task='{g['task']}' steps={g['steps']}/{g['max_steps']} "
          f"{states}{flags}{' COMPLETE' if done else ''}", file=sys.stderr)
    print_frontier(g)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "init":
        cmd_init(sys.argv[2:])
    elif cmd == "next":
        cmd_next()
    elif cmd == "advance":
        cmd_advance(sys.argv[2:])
    elif cmd == "resume":
        cmd_resume(sys.argv[2:])
    elif cmd == "status":
        cmd_status()
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
