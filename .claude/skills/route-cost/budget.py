#!/usr/bin/env python3
"""Phase 4 budget estimator: cost a routed plan against the rates table.

Reads a JSONL plan (one task per line) and models.json, computes estimated USD
per task and the total, and exits 1 if the total exceeds ceiling_usd — so it can
gate a batch before you spend. Token counts are *estimates* you provide; for
actuals, read Claude Code's /cost or the session usage.

Plan line shape (token fields are thousands of tokens):
  {"task": "build auth", "tier": "top", "in_ktok": 40, "out_ktok": 8, "cached_ktok": 30}
cached_ktok is the portion of input served from cache (billed at the read rate).
An optional "project" field (memory-os slug) is tolerated and ignored — forward
plumbing only; unknown fields never affect pricing.
"""
import sys, json, os


def load_rates():
    return json.load(open(os.path.join(os.path.dirname(__file__), "models.json")))


def cost(row, cfg):
    t = cfg["tiers"][row["tier"]]
    in_k = row.get("in_ktok", 0)
    out_k = row.get("out_ktok", 0)
    cached_k = min(row.get("cached_ktok", 0), in_k)
    fresh_in = in_k - cached_k
    # rates are per MTok; ktok / 1000 = MTok
    usd = (
        fresh_in / 1000 * t["in_per_mtok"]
        + cached_k / 1000 * t["in_per_mtok"] * cfg["cache_read_mult"]
        + out_k / 1000 * t["out_per_mtok"]
    )
    return usd


def main():
    if len(sys.argv) < 2:
        print("usage: budget.py <plan.jsonl>", file=sys.stderr)
        return 2
    cfg = load_rates()
    ceiling = cfg["ceiling_usd"]
    total = 0.0
    print(f"{'tier':8} {'model':18} {'USD':>8}  task")
    for ln in open(sys.argv[1]):
        ln = ln.strip()
        if not ln:
            continue
        row = json.loads(ln)
        c = cost(row, cfg)
        total += c
        print(f"{row['tier']:8} {cfg['tiers'][row['tier']]['model']:18} {c:8.3f}  {row.get('task','')}")
    print(f"{'':8} {'TOTAL':18} {total:8.3f}  (ceiling {ceiling})")
    if total > ceiling:
        print(f"OVER BUDGET by {total - ceiling:.3f} USD")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
