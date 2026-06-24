// web/scene/perf.ts
// Locked r3f performance floors — the named v1 tokens from the design package
// (§C + stress-test): instanced-only ambient cap, max bloom-radius, min
// node-radius. Pure helpers so the floors are enforced in one place and unit-tested.

export const MAX_AMBIENT_NODES = 2000; // ~2k-node cap, single instanced draw call
export const MIN_NODE_RADIUS = 0.18;   // below this a burst degrades to a static ring
export const MAX_BLOOM_RADIUS = 0.85;  // bloom-radius ceiling (prevents violet/cyan collision)
export const TARGET_FPS = 60;

export interface NodeRender {
  radius: number;
  /** True when the requested radius was below the floor — caller renders a static ring. */
  degradeToRing: boolean;
}

/** Apply the min node-radius floor; below the floor the burst degrades to a ring. */
export function nodeRender(requested: number): NodeRender {
  return { radius: Math.max(requested, MIN_NODE_RADIUS), degradeToRing: requested < MIN_NODE_RADIUS };
}

/** Clamp an ambient-field request to the instanced cap (and to a non-negative int). */
export function clampAmbientCount(requested: number): number {
  if (!Number.isFinite(requested)) return 0;
  return Math.max(0, Math.min(Math.floor(requested), MAX_AMBIENT_NODES));
}

/** Clamp a bloom radius to [0, MAX_BLOOM_RADIUS]. */
export function clampBloomRadius(r: number): number {
  return Math.min(Math.max(r, 0), MAX_BLOOM_RADIUS);
}
