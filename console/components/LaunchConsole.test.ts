import { describe, it, expect } from "vitest";
import { buildLaunchPayload, type LaunchProject } from "./LaunchConsole";

const projects: LaunchProject[] = [
  { id: "p1", name: "Project One" },
  { id: "p2", name: "Project Two" },
];

describe("buildLaunchPayload — decompose toggle (default OFF)", () => {
  it("omits `decompose` entirely when the toggle is off (default)", () => {
    const p = buildLaunchPayload("p1", projects, "build the thing", "auto", false);
    expect(p).toEqual({
      projectId: "p1",
      projectName: "Project One",
      brief: "build the thing",
      modelRouting: "auto",
    });
    expect("decompose" in p).toBe(false);
  });

  it("includes `decompose: true` when the toggle is on", () => {
    const p = buildLaunchPayload("p1", projects, "build the thing", "auto", true);
    expect(p.decompose).toBe(true);
  });

  it("never emits `decompose: false` — absent means off, not a false value", () => {
    const p = buildLaunchPayload("p2", projects, "brief", "sonnet", false);
    expect(p.decompose).toBeUndefined();
  });

  it("trims the brief and resolves the project name from the roster", () => {
    const p = buildLaunchPayload("p2", projects, "  padded brief  ", "haiku", false);
    expect(p.brief).toBe("padded brief");
    expect(p.projectName).toBe("Project Two");
  });

  it("falls back to the raw id as projectName when the project isn't in the roster", () => {
    const p = buildLaunchPayload("unknown-id", projects, "brief", "auto", false);
    expect(p.projectName).toBe("unknown-id");
  });
});
