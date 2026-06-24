// web/scene/NodeGraph.test.tsx
// Proves the scene is a live projection: NodeGraph renders a mesh per projected
// node/edge and re-renders when the store commits (via useRunState → flush). This
// is the render-level lock for the C11 fix; project_scene's math is covered
// separately in sceneGraph.test.ts.
//
// drei <Text> is mocked out — troika font loading is async/heavy and irrelevant
// here; we assert on the geometry meshes (nodes + edges).
import { describe, it, expect, vi } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { createStore } from "@/lib/store/store";
import { initialRunState } from "@/lib/contract/types";
import { NodeGraph } from "./NodeGraph";

vi.mock("@react-three/drei", () => ({
  Text: () => null,
}));

describe("NodeGraph — live scene projection", () => {
  it("renders meshes for the projected graph and tracks store commits", async () => {
    const store = createStore(initialRunState);
    const renderer = await ReactThreeTestRenderer.create(<NodeGraph store={store} />);

    // Initial: 1 task node + 6 phase nodes + 6 task→phase edges = 13 meshes.
    const before = renderer.scene.findAllByType("Mesh").length;
    expect(before).toBeGreaterThanOrEqual(7); // at least the node meshes

    // Add one subtask and flush: the scene must gain exactly one node mesh and
    // one edge mesh (phase→subtask), proving it re-projects on commit.
    await ReactThreeTestRenderer.act(async () => {
      store.apply({ type: "subtask", id: "st-a", status: "building", phase: 1 });
      store.flush();
    });

    const after = renderer.scene.findAllByType("Mesh").length;
    expect(after - before).toBe(2);
  });
});
