// web/scene/AmbientField.test.tsx
// The ambient backdrop must be a SINGLE instanced draw call with its count
// clamped to the ~2k cap (design package §C). (three's InstancedMesh reports
// .type === "Mesh"; we assert it is instanced via isInstancedMesh.)
import { describe, it, expect } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { AmbientField } from "./AmbientField";
import { MAX_AMBIENT_NODES } from "./perf";

type InstancedLike = { isInstancedMesh?: boolean; count: number };

async function instancedCount(count: number): Promise<number> {
  const renderer = await ReactThreeTestRenderer.create(<AmbientField count={count} />);
  const meshes = renderer.scene.findAllByType("Mesh");
  const instanced = meshes.filter((m) => (m.instance as InstancedLike).isInstancedMesh);
  expect(instanced).toHaveLength(1); // exactly one instanced draw call
  return (instanced[0].instance as InstancedLike).count;
}

describe("AmbientField", () => {
  it("renders one instanced mesh sized to the requested count", async () => {
    expect(await instancedCount(64)).toBe(64);
  });

  it("clamps an over-cap request to the ~2k ceiling", async () => {
    expect(await instancedCount(50_000)).toBe(MAX_AMBIENT_NODES);
  });
});
