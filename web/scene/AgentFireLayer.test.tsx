// web/scene/AgentFireLayer.test.tsx
// One burst mesh per agent-fire whose subtask has a node; renders at that node.
import { describe, it, expect } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { createStore } from "@/lib/store/store";
import { initialRunState } from "@/lib/contract/types";
import { AgentFireLayer } from "./AgentFireLayer";

describe("AgentFireLayer", () => {
  it("renders a burst mesh per fire whose subtask is in the graph", async () => {
    const store = createStore(initialRunState);
    store.apply({ type: "subtask", id: "st-a", status: "building", phase: 2 });
    store.apply({
      type: "agentFire",
      id: "ev-1",
      subtaskId: "st-a",
      kind: "gate",
      severity: "critical",
      firedAt: 1,
    });
    store.flush();

    const renderer = await ReactThreeTestRenderer.create(<AgentFireLayer store={store} />);
    expect(renderer.scene.findAllByType("Mesh")).toHaveLength(1);
  });

  it("renders nothing when no fire's subtask has a node", async () => {
    const store = createStore(initialRunState); // no subtasks
    store.apply({
      type: "agentFire",
      id: "ev-x",
      subtaskId: "ghost",
      kind: "gate",
      severity: "high",
      firedAt: 1,
    });
    store.flush();

    const renderer = await ReactThreeTestRenderer.create(<AgentFireLayer store={store} />);
    expect(renderer.scene.findAllByType("Mesh")).toHaveLength(0);
  });
});
