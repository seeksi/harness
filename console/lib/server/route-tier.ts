// console/lib/server/route-tier.ts
// Deterministic keyword model router — the TypeScript spine of Phase-4 per-lane routing.
// Ported VERBATIM from .claude/skills/route-cost/route.py (the canonical heuristic): the
// TOP/CHEAP regexes below MUST stay byte-in-sync with that file's TOP/CHEAP patterns. Keyword
// matching on purpose — a classifier model would cost more than it saves at this scale.
//
// Tier→model follows route-cost/models.json's tier order: TOP→opus (hard reasoning /
// correctness-critical, the cross-review reconcile), CHEAP→haiku (mechanical, scaffolding,
// read-only exploration), everything else→sonnet (ordinary implementation). The brief is a
// free child-controlled string — it steers ONLY spend (which model), never any provenance-
// bearing value, so no sanitization is owed here beyond the case-fold route.py itself does.

// top tier: hard reasoning, correctness-critical, the cross-review reconcile
const TOP = /architect|design\b|security|threat|review|reconcile|migrat|debug|root.?cause|tricky|concurren/;
// cheap tier: mechanical, scaffolding, read-only exploration
const CHEAP = /boilerplate|scaffold|\btest\b|\bdocs?\b|comment|rename|format|lint|explore|search|read\b|typo/;

/**
 * Route one task brief to a model tier. Case-insensitive (lower-case first, exactly as
 * route.py does — an explicit fold rather than a /i flag so the two implementations read
 * identically). Unanchored search (RegExp.test, mirroring re.search): a keyword anywhere in
 * the brief hits. TOP wins over CHEAP when both match (same precedence as route.py).
 */
export function routeModel(brief: string): "haiku" | "sonnet" | "opus" {
  const t = brief.toLowerCase();
  if (TOP.test(t)) return "opus"; // top: hard reasoning / correctness-critical
  if (CHEAP.test(t)) return "haiku"; // cheap: mechanical or read-only
  return "sonnet"; // default: ordinary implementation
}
