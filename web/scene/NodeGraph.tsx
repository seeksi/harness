// web/scene/NodeGraph.tsx
// Lane B — the scene projection. A PURE projection of RunState: it subscribes to
// the store via useRunState (useSyncExternalStore), which the store notifies
// EXACTLY ONCE PER rAF FLUSH — so the scene re-renders on the same
// one-flush-per-frame clock as the DOM mirror and tracks ALL of state (nodes,
// edges, AND the headline), not just the headline. Imports NOTHING from hud/**
// and never touches the DOM.
//
// (Earlier this read refs during render + mutated only the headline in useFrame,
// which froze the node/edge meshes at the initial projection — C11. Subscribing
// is both correct and simpler at this node count.)
//
// ponytail: at this scale (a few dozen nodes) React reconciliation per flush is
// fine. The ≤2k instanced ambient field is a SEPARATE imperative/instanced layer
// (graphify-field increment) and will not route per-node through React.
// Minimal renderer: phase rail + subtask nodes as basic meshes, plus drei <Text>.
// NO bloom, NO instancing, NO ambient field, NO motion tokens yet.

"use client";

import { useMemo } from "react";
import { Text } from "@react-three/drei";
import type { RunStore } from "@/lib/contract/store";
import { useRunState } from "@/lib/store/useRunState";
import { project_scene } from "./sceneGraph";
import { statusColor } from "./tokens";
import { nodeRender } from "./perf";

// Emissive strength by status — "live" nodes glow (and pick up bloom); idle stays dim.
function emissiveIntensity(status?: string): number {
  switch (status) {
    case "active":
    case "building":
    case "running":
      return 0.85;
    case "blocked":
    case "failed":
      return 0.75;
    case "reviewed":
      return 0.6;
    case "done":
    case "merged":
      return 0.45;
    default:
      return 0.12;
  }
}

export function NodeGraph({ store }: { store: RunStore }) {
  const state = useRunState(store);
  const graph = useMemo(() => project_scene(state), [state]);
  const s = graph.summary;
  const headline = `task: ${s.taskId}\nphase ${s.currentPhase} · ${s.currentPhaseLabel}\ngates: ${s.gateCount} (${s.raisedGateCount} raised)\nactive: ${s.activeSubtask ?? "—"}`;

  return (
    <group>
      {/* headline facts as plain 3D text */}
      <Text
        position={[0, 4, 0]}
        fontSize={0.4}
        color="#e6e8ec"
        anchorX="center"
        anchorY="middle"
        textAlign="center"
      >
        {headline}
      </Text>

      {/* nodes as basic meshes; sphere radius respects the min node-radius floor */}
      {graph.nodes.map((n) => {
        const color = statusColor(n.status);
        const radius = nodeRender(n.kind === "phase" ? 0.35 : 0.25).radius;
        return (
          <mesh key={n.id} position={n.position}>
            {n.kind === "task" ? (
              <boxGeometry args={[0.7, 0.7, 0.7]} />
            ) : (
              <sphereGeometry args={[radius, 16, 16]} />
            )}
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={emissiveIntensity(n.status)}
            />
          </mesh>
        );
      })}

      {/* node labels (restrained) */}
      {graph.nodes
        .filter((n) => n.kind !== "task")
        .map((n) => (
          <Text
            key={`label-${n.id}`}
            position={[n.position[0], n.position[1] - 0.5, n.position[2]]}
            fontSize={0.18}
            color="#9aa0aa"
            anchorX="center"
            anchorY="middle"
          >
            {n.label}
          </Text>
        ))}

      {/* edges as thin lines (basic; no instancing) */}
      {graph.edges.map((e) => {
        const a = graph.nodes.find((n) => n.id === e.from);
        const b = graph.nodes.find((n) => n.id === e.to);
        if (!a || !b) return null;
        return <EdgeLine key={e.id} from={a.position} to={b.position} />;
      })}
    </group>
  );
}

function EdgeLine({
  from,
  to,
}: {
  from: [number, number, number];
  to: [number, number, number];
}) {
  // ponytail: drawn as a degenerate thin box between endpoints to avoid the
  // <line> raw-geometry boilerplate. add a proper LineSegments/instanced edge
  // layer with the perf increment.
  const mx = (from[0] + to[0]) / 2;
  const my = (from[1] + to[1]) / 2;
  const mz = (from[2] + to[2]) / 2;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy, to[2] - from[2]) || 0.0001;
  const angleZ = Math.atan2(dy, dx);
  return (
    <group position={[mx, my, mz]} rotation={[0, 0, angleZ]}>
      <mesh>
        <boxGeometry args={[len, 0.02, 0.02]} />
        <meshStandardMaterial color="#2a2f3a" />
      </mesh>
    </group>
  );
}
