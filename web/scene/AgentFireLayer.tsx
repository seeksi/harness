// web/scene/AgentFireLayer.tsx
// Lane B — agent-fire bursts at their subtask's node position. Pure projection of
// state.agentEvents: severity-ordered co-fire stagger (agentFire.ts) + the
// <120ms attack → 400–600ms decay envelope (motion.ts). Because the dry-run
// fixture's firedAt are synthetic, the envelope is driven from each fire's
// ARRIVAL time in state (wall clock), not firedAt. Under prefers-reduced-motion
// the burst becomes an instant, persistent static highlight (no bloom/animation).
"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, type Mesh, type MeshStandardMaterial } from "three";
import type { RunStore } from "@/lib/contract/store";
import { useRunState } from "@/lib/store/useRunState";
import { project_scene } from "./sceneGraph";
import { staggerFires } from "./agentFire";
import { fireEnvelope, prefersReducedMotion } from "./motion";
import { fireColor } from "./tokens";
import { nodeRender } from "./perf";

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export function AgentFireLayer({ store }: { store: RunStore }) {
  const state = useRunState(store);
  const graph = useMemo(() => project_scene(state), [state]);
  const reduced = prefersReducedMotion();
  const fires = useMemo(() => staggerFires(state.agentEvents), [state.agentEvents]);

  // Arrival time per fire id (wall clock), recorded in-frame the first time we
  // see it (ref writes belong in the frame loop, never in render).
  const firstSeen = useRef<Map<string, number>>(new Map());
  const meshes = useRef<Map<string, Mesh>>(new Map());

  const positionOf = (subtaskId: string): [number, number, number] | null => {
    const node = graph.nodes.find((n) => n.id === `subtask-${subtaskId}`);
    return node ? node.position : null;
  };

  useFrame(() => {
    const t = now();
    for (const f of fires) {
      if (!firstSeen.current.has(f.id)) firstSeen.current.set(f.id, t);
      const mesh = meshes.current.get(f.id);
      if (!mesh) continue;
      const elapsed = t - (firstSeen.current.get(f.id) ?? t) - f.peakOffsetMs;
      // motion-lite: instant, persistent highlight; otherwise the fire envelope.
      const env = reduced ? (elapsed >= 0 ? 1 : 0) : fireEnvelope(elapsed);
      mesh.visible = env > 0.01;
      mesh.scale.setScalar(0.3 + env * 0.9);
      const mat = mesh.material as MeshStandardMaterial;
      mat.emissiveIntensity = env * 2.5;
    }
    // prune arrival times for fires that have aged out of state.agentEvents
    if (firstSeen.current.size > fires.length) {
      const live = new Set(fires.map((f) => f.id));
      for (const id of [...firstSeen.current.keys()]) {
        if (!live.has(id)) firstSeen.current.delete(id);
      }
    }
  });

  return (
    <group>
      {fires.map((f) => {
        const pos = positionOf(f.subtaskId);
        if (!pos) return null;
        const color = new Color(fireColor(f.severity));
        return (
          <mesh
            key={f.id}
            position={pos}
            visible={false}
            ref={(m) => {
              if (m) meshes.current.set(f.id, m);
              else meshes.current.delete(f.id);
            }}
          >
            <sphereGeometry args={[nodeRender(0.28).radius, 16, 16]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0} transparent opacity={0.9} />
          </mesh>
        );
      })}
    </group>
  );
}
