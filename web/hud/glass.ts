// web/hud/glass.ts
// Glass HUD surface tokens. GLASS_OPACITY_FLOOR is the mandatory v1 token (design
// package §A): the minimum background alpha that keeps 12px Geist Mono text ≥4.5:1
// under peak neon-burst bloom, back-solved from worst-case composite luminance.
// Never set a glass surface below this floor.
import type { CSSProperties } from "react";

// ponytail: exact alpha is build-profiled against the bloom composite; 0.82 is the
// conservative floor that survived the stress-test worst case.
export const GLASS_OPACITY_FLOOR = 0.82;

/** Glass surface style; alpha is clamped UP to the floor (never below). */
export function glassSurface(alpha: number = GLASS_OPACITY_FLOOR): CSSProperties {
  return {
    backgroundColor: `hsla(222, 14%, 9%, ${Math.max(alpha, GLASS_OPACITY_FLOOR)})`,
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    border: "1px solid hsla(258, 35%, 45%, 0.25)", // accent-mid edge
    color: "var(--text)",
    boxShadow: "0 16px 48px -20px hsla(264, 82%, 30%, 0.55)", // indigo→violet lift
  } as CSSProperties;
}
