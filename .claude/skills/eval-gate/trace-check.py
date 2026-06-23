#!/usr/bin/env python3
"""Phase 3 trajectory gate: flag loop / explosion / thrash signals in a trace.

Reads a .claude/traces/<session>.jsonl produced by trace-log.py and reports the
trajectory shape. Exits 1 if any hard threshold is breached, so it can gate a
merge or a CI step. Tune the thresholds for your app.
"""
import sys, json, collections

LOOP_RUN = 3      # >= N identical consecutive (tool,sig) calls => stuck in a loop
MAX_CALLS = 200   # total tool-call budget per session
DOMINANCE = 0.6   # one tool > this share of calls (when >=20 calls) => thrashing


def load(path):
    rows = []
    with open(path) as f:
        for ln in f:
            ln = ln.strip()
            if ln:
                rows.append(json.loads(ln))
    return rows


def main():
    if len(sys.argv) < 2:
        print("usage: trace-check.py <trace.jsonl>", file=sys.stderr)
        return 2
    rows = load(sys.argv[1])
    n = len(rows)
    key = lambda r: (r.get("tool"), r.get("sig"))

    longest = cur = 1 if n else 0
    for i in range(1, n):
        cur = cur + 1 if key(rows[i]) == key(rows[i - 1]) else 1
        longest = max(longest, cur)

    counts = collections.Counter(r.get("tool") for r in rows)
    print(f"trace: {sys.argv[1]}")
    print(f"  tool calls: {n}")
    for t, c in counts.most_common():
        print(f"    {t}: {c}")
    print(f"  longest identical run: {longest}")

    flags = []
    if longest >= LOOP_RUN:
        flags.append(f"LOOP: {longest} identical calls in a row (>= {LOOP_RUN})")
    if n > MAX_CALLS:
        flags.append(f"EXPLOSION: {n} tool calls (> {MAX_CALLS})")
    if n >= 20:
        top, topc = counts.most_common(1)[0]
        if topc / n > DOMINANCE:
            flags.append(f"THRASH: {top} is {topc/n:.0%} of calls (> {DOMINANCE:.0%})")

    if flags:
        print("FLAGS:")
        for fl in flags:
            print(f"  x {fl}")
        return 1
    print("OK: no trajectory anomalies")
    return 0


if __name__ == "__main__":
    sys.exit(main())
