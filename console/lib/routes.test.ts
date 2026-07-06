import { describe, it, expect } from "vitest";
import { runRoute, deckRunRoute } from "./routes";

describe("runRoute", () => {
  it("builds the run-focus deep link", () => {
    expect(runRoute("run-123")).toBe("/run/run-123");
  });

  it("encodes runIds containing URL-unsafe characters", () => {
    expect(runRoute("run/weird id")).toBe("/run/run%2Fweird%20id");
  });
});

describe("deckRunRoute", () => {
  it("builds the run-scoped deck drill-through link", () => {
    expect(deckRunRoute("run-123")).toBe("/deck?run=run-123");
  });

  it("encodes runIds containing URL-unsafe characters", () => {
    expect(deckRunRoute("run/weird id")).toBe("/deck?run=run%2Fweird%20id");
  });
});
