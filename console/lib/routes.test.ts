import { describe, it, expect } from "vitest";
import { runRoute } from "./routes";

describe("runRoute", () => {
  it("builds the run-focus deep link", () => {
    expect(runRoute("run-123")).toBe("/run/run-123");
  });

  it("encodes runIds containing URL-unsafe characters", () => {
    expect(runRoute("run/weird id")).toBe("/run/run%2Fweird%20id");
  });
});
