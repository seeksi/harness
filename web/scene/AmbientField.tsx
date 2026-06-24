// web/scene/AmbientField.tsx
// Lane B — the dim "graphify" backdrop as a SINGLE instanced draw call (design
// package §C instanced-only mandate, ~2k cap enforced in ambientField.ts/perf.ts).
// Soft sine breathing on the whole field (one cheap transform), frozen under
// prefers-reduced-motion. Never reads the DOM or hud/**.
"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Object3D, Color, type InstancedMesh } from "three";
import { generateAmbientField } from "./ambientField";
import { breathe, prefersReducedMotion } from "./motion";
import { ACCENT } from "./tokens";

export function AmbientField({ count = 1200, seed = 0x5eed }: { count?: number; seed?: number }) {
  const positions = useMemo(() => generateAmbientField(count, seed), [count, seed]);
  const n = positions.length / 3;
  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(ACCENT.restGlow), []);
  const reduced = prefersReducedMotion();

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < n; i++) {
      dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [positions, n, dummy]);

  useFrame(({ clock }) => {
    if (reduced) return; // motion-lite: freeze continuous motion (topology preserved)
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.scale.setScalar(1 + breathe(clock.elapsedTime * 1000) * 0.015);
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, n]}>
      <sphereGeometry args={[0.035, 6, 6]} />
      <meshBasicMaterial color={color} transparent opacity={0.45} />
    </instancedMesh>
  );
}
