#!/usr/bin/env python3
"""Phase 3 trace distiller: compact JSON summary of a trace session.

Sibling of trace-check.py (same input, same thresholds) but informational only:
prints one compact JSON object {total_calls, tool_histogram, top_repeated_sig,
flags} so the orchestrator can read a summary instead of the raw JSONL. It does
NOT gate — trace-check.py owns the exit-code contract. Exits 0 on any readable
trace (flags or not), 2 on usage error.
"""
import sys, json, collections

LOOP_RUN = 3      # keep in lockstep with trace-check.py
MAX_CALLS = 200
DOMINANCE = 0.6


def main():
    if len(sys.argv) < 2:
        print("usage: trace-distill.py <trace.jsonl>", file=sys.stderr)
        return 2
    rows = [json.loads(ln) for ln in open(sys.argv[1]) if ln.strip()]
    n = len(rows)
    key = lambda r: (r.get("tool"), r.get("sig"))
    counts = collections.Counter(r.get("tool") for r in rows)

    longest, cur = (1, 1) if n else (0, 0)
    top_sig = key(rows[0]) if n else None
    for i in range(1, n):
        cur = cur + 1 if key(rows[i]) == key(rows[i - 1]) else 1
        if cur > longest:
            longest, top_sig = cur, key(rows[i])

    flags = []
    if longest >= LOOP_RUN:
        flags.append(f"LOOP:{longest}")
    if n > MAX_CALLS:
        flags.append(f"EXPLOSION:{n}")
    if n >= 20:
        top, topc = counts.most_common(1)[0]
        if topc / n > DOMINANCE:
            flags.append(f"THRASH:{top}:{topc/n:.0%}")

    print(json.dumps({
        "total_calls": n,
        "tool_histogram": dict(counts.most_common()),
        "top_repeated_sig": (
            {"tool": top_sig[0], "sig": top_sig[1], "run": longest} if top_sig else None
        ),
        "flags": flags,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
