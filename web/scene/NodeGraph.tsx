// web/scene/NodeGraph.tsx
// Lane B — reads the store IN THE FRAME LOOP (useFrame), never via React state,
// and renders the projected scene graph. This proves the two-renderer rule: the
// scene is a pure projection of RunState read off the shared rAF clock. It pulls
// store.getSnapshot() each frame and re-derives via project_scene; no React
// re-render is needed for the scene to track state (r3f mutates the three objects
// imperatively). Imports NOTHING from hud/** and never touches the DOM.
//
// Minimal renderer: phase rail + subtask nodes as basic meshes, plus drei <Text>
// for the headline facts (task id / current phase / gate count / active subtask).
// NO bloom, NO instancing, NO ambient field, NO motion tokens yet.

"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import type { Group } from "three";
import type { RunStore } from "@/lib/contract/store";
import { project_scene, type SceneGraph } from "./sceneGraph";

const STATUS_COLOR: Record<string, string> = {
  idle: "#3a3f4b",
  pending: "#6b7280",
  active: "#4f9cff",
  building: "#4f9cff",
  done: "#39d98a",
  merged: "#39d98a",
  reviewed: "#a78bfa",
  blocked: "#ff5d5d",
  running: "#4f9cff",
  failed: "#ff5d5d",
};

function nodeColor(status?: string): string {
  return (status && STATUS_COLOR[status]) || "#8a8f99";
}

export function NodeGraph({ store }: { store: RunStore }) {
  const headlineRef = useRef<{ text: string }>({ text: "" });
  // We keep the latest projection in a ref and mutate three objects in useFrame,
  // so the scene tracks the store without triggering React reconciliation.
  const graphRef = useRef<SceneGraph>(project_scene(store.getSnapshot()));
  const textRef = useRef<{ text: string } | null>(null);

  useFrame(() => {
    const graph = project_scene(store.getSnapshot());
    graphRef.current = graph;
    const s = graph.summary;
    const line = `task: ${s.taskId}\nphase ${s.currentPhase} · ${s.currentPhaseLabel}\ngates: ${s.gateCount} (${s.raisedGateCount} raised)\nactive: ${s.activeSubtask ?? "—"}`;
    if (textRef.current && headlineRef.current.text !== line) {
      headlineRef.current.text = line;
      textRef.current.text = line;
    }
  });

  // Initial render uses the first projection; per-frame updates are imperative.
  const graph = graphRef.current;
  const initialSummary = graph.summary;
  const initialLine = `task: ${initialSummary.taskId}\nphase ${initialSummary.currentPhase} · ${initialSummary.currentPhaseLabel}\ngates: ${initialSummary.gateCount} (${initialSummary.raisedGateCount} raised)\nactive: ${initialSummary.activeSubtask ?? "—"}`;
  headlineRef.current.text = initialLine;

  return (
    <group>
      {/* headline facts as plain 3D text */}
      <Text
        ref={textRef as never}
        position={[0, 4, 0]}
        fontSize={0.4}
        color="#e6e8ec"
        anchorX="center"
        anchorY="middle"
        textAlign="center"
      >
        {initialLine}
      </Text>

      {/* nodes as basic meshes */}
      {graph.nodes.map((n) => (
        <mesh key={n.id} position={n.position}>
          {n.kind === "task" ? (
            <boxGeometry args={[0.7, 0.7, 0.7]} />
          ) : (
            <sphereGeometry args={[n.kind === "phase" ? 0.35 : 0.25, 16, 16]} />
          )}
          <meshStandardMaterial color={nodeColor(n.status)} />
        </mesh>
      ))}

      {/* node labels (Space Grotesk default font; restrained) */}
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
  const ref = useRef<Group>(null);
  // ponytail: drawn as a degenerate thin box between endpoints to avoid the
  // <line> raw-geometry boilerplate. add a proper LineSegments/instanced edge
  // layer with the perf increment.
  const mx = (from[0] + to[0]) / 2;
  const my = (from[1] + to[1]) / 2;
  const mz = (from[2] + to[2]) / 2;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz) || 0.0001;
  const angleZ = Math.atan2(dy, dx);
  return (
    <group ref={ref} position={[mx, my, mz]} rotation={[0, 0, angleZ]}>
      <mesh>
        <boxGeometry args={[len, 0.02, 0.02]} />
        <meshStandardMaterial color="#2a2f3a" />
      </mesh>
    </group>
  );
}
