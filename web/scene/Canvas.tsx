// web/scene/Canvas.tsx
// Lane B — the single <Canvas> client mount. Owns the r3f frame loop the store's
// flush feeds; everything inside reads the store via getSnapshot() in useFrame
// (NodeGraph), so the scene is a pure projection of RunState with no DOM reads
// and no hud/** imports. The store instance is passed in (the interface from the
// contract), so this module never imports the store implementation directly —
// keeping the eslint import-boundary clean.
//
// Minimal lighting + camera only. NO bloom/postprocessing, NO ambient field, NO
// motion tokens this increment.

"use client";

import { Canvas as R3FCanvas } from "@react-three/fiber";
import type { RunStore } from "@/lib/contract/store";
import { NodeGraph } from "./NodeGraph";

export function Canvas({ store }: { store: RunStore }) {
  return (
    <R3FCanvas camera={{ position: [0, 1, 12], fov: 50 }}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={0.8} />
      <NodeGraph store={store} />
    </R3FCanvas>
  );
}

// ponytail: scene composition ceiling.
// skipped: <EffectComposer>/Bloom.tsx, add with the bloom increment (max-bloom-radius + min-node-radius floor).
// skipped: AmbientField.tsx instanced backdrop, add with the graphify-field increment.
// skipped: motion.ts breathing/energy-ramp + reduced-motion handling, add with the motion increment.
// skipped: perf.ts draw-call ceiling + frameloop policy, add when node/draw counts grow.
