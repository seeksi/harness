#!/usr/bin/env python3
"""Phase 4 model router: task description -> tier + Claude model id.

Cheap work goes to Haiku, the hard reasoning goes to Opus, everything else to
Sonnet. Keyword-based on purpose — a classifier model would cost more than it
saves at this scale. Use the printed model id as the subagent/review model.
"""
import sys, json, os, re

# top tier: hard reasoning, correctness-critical, the cross-review reconcile
TOP = r"architect|design\b|security|threat|review|reconcile|migrat|debug|root.?cause|tricky|concurren"
# cheap tier: mechanical, scaffolding, read-only exploration
CHEAP = r"boilerplate|scaffold|\btest\b|\bdocs?\b|comment|rename|format|lint|explore|search|read\b|typo"


def route(task: str) -> tuple[str, str]:
    t = task.lower()
    if re.search(TOP, t):
        return "top", "hard reasoning / correctness-critical"
    if re.search(CHEAP, t):
        return "cheap", "mechanical or read-only"
    return "default", "ordinary implementation"


def main():
    if len(sys.argv) < 2:
        print("usage: route.py <task description>", file=sys.stderr)
        return 2
    task = " ".join(sys.argv[1:])
    tier, why = route(task)
    cfg = json.load(open(os.path.join(os.path.dirname(__file__), "models.json")))
    model = cfg["tiers"][tier]["model"]
    print(f"tier:  {tier}  ({why})")
    print(f"model: {model}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
