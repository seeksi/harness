// web/scene/motion.ts
// Named motion tokens (design package §D) + easing math. Pure and SSR-safe so the
// timing grammar lives in one place and is unit-tested:
//   surgical foreground <200ms ease-out · ambient 600–900ms sine breathing ·
//   agent-fire <120ms attack → 400–600ms organic decay · backdrop 1.2–1.8s ease-in
//   energy ramp · 80–120ms severity-ordered co-fire stagger.

export const MOTION = {
  foregroundMs: 180, // surgical foreground: <200ms ease-out
  breathingMs: 750, // ambient layer: 600–900ms sine breathing
  fireAttackMs: 110, // agent-fire: <120ms attack
  fireDecayMs: 520, // agent-fire: 400–600ms organic bloom/decay
  energyRampMs: 1500, // backdrop energy ramp: 1.2–1.8s ease-in
  coFireStaggerMs: 100, // co-fire: 80–120ms severity-ordered offset
} as const;

/** Soft sine breathing in [0,1], one full cycle per periodMs. */
export function breathe(elapsedMs: number, periodMs: number = MOTION.breathingMs): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * elapsedMs) / periodMs);
}

/** Quadratic ease-in for the backdrop energy ramp; input/output clamped to [0,1]. */
export function easeInRamp(t01: number): number {
  const t = Math.min(1, Math.max(0, t01));
  return t * t;
}

/**
 * Agent-fire envelope in [0,1]: linear attack to 1 over fireAttackMs, then
 * exponential decay over fireDecayMs, returning 0 once fully decayed.
 */
export function fireEnvelope(elapsedMs: number): number {
  if (elapsedMs < 0) return 0;
  if (elapsedMs < MOTION.fireAttackMs) return elapsedMs / MOTION.fireAttackMs;
  const d = elapsedMs - MOTION.fireAttackMs;
  if (d > MOTION.fireDecayMs) return 0;
  return Math.exp(-3 * (d / MOTION.fireDecayMs));
}

/** prefers-reduced-motion, SSR-safe (false when there is no window/matchMedia). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
