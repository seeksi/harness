// web/scene/Canvas.tsx
// Lane B — the single <Canvas> client mount. Composes the layered scene off ONE
// store (the interface, never the impl): instanced ambient backdrop, the live
// node graph, agent-fire bursts, and bloom postprocessing. Everything reads the
// store via getSnapshot/useRunState; no DOM reads, no hud/** imports.
//
// Bloom radius is the locked MAX_BLOOM_RADIUS ceiling; bloom is suppressed under
// prefers-reduced-motion (design package §reduced-motion: no bloom in motion-lite).
"use client";

import { Canvas as R3FCanvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import type { RunStore } from "@/lib/contract/store";
import { NodeGraph } from "./NodeGraph";
import { AmbientField } from "./AmbientField";
import { AgentFireLayer } from "./AgentFireLayer";
import { BASE_SURFACE } from "./tokens";
import { MAX_BLOOM_RADIUS } from "./perf";
import { prefersReducedMotion } from "./motion";

export function Canvas({ store }: { store: RunStore }) {
  const reduced = prefersReducedMotion();
  return (
    <R3FCanvas camera={{ position: [0, 1, 12], fov: 50 }}>
      <color attach="background" args={[BASE_SURFACE]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 8, 5]} intensity={0.7} />

      <AmbientField />
      <NodeGraph store={store} />
      <AgentFireLayer store={store} />

      {!reduced && (
        <EffectComposer>
          <Bloom
            intensity={0.9}
            radius={MAX_BLOOM_RADIUS}
            luminanceThreshold={0.2}
            luminanceSmoothing={0.9}
            mipmapBlur
          />
        </EffectComposer>
      )}
    </R3FCanvas>
  );
}

// ponytail: motion.ts breathing is wired into AmbientField; per-node rest-glow pulse
// + restrained-spring node settle land with the node-motion increment.
// ponytail: LOD/cull on the ambient layer when the field grows toward the 2k cap.
