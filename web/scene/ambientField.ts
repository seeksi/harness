// web/scene/ambientField.ts
// Pure, deterministic layout for the instanced ambient "graphify" backdrop. The
// component renders these as a SINGLE instanced draw call (design package §C
// instanced-only mandate). Deterministic (seeded) so renders/tests are stable;
// count is clamped to the ~2k cap. Points sit in a shell pushed behind the
// foreground so they never occlude the live node graph.

import { clampAmbientCount } from "./perf";

/** mulberry32 — small deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate the ambient field as a flat [x,y,z,...] array, deterministic for a
 * given seed, length clamped to the instanced cap. Returned length is count*3.
 */
export function generateAmbientField(count: number, seed = 0x5eed): Float32Array {
  const n = clampAmbientCount(count);
  const rng = mulberry32(seed);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 14 + rng() * 12; // shell radius 14..26
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    out[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    out[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    out[i * 3 + 2] = -8 - rng() * 18; // pushed behind the foreground
  }
  return out;
}
