// aria-live region tests.
// Verifies: polite region is aria-live="polite"; critical gate assertive region is "assertive".
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveRegion, HudLiveRegions } from "../LiveRegion";

describe("LiveRegion — aria-live attribute", () => {
  it("renders aria-live=polite for polite messages", () => {
    render(<LiveRegion politeness="polite" message="Phase 1 started" label="updates" />);
    const region = screen.getByRole("status", { name: "updates" });
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("renders aria-live=assertive for critical gate escalations", () => {
    render(<LiveRegion politeness="assertive" message="Gate D raised — CRITICAL" label="critical gates" />);
    const region = screen.getByRole("status", { name: "critical gates" });
    expect(region.getAttribute("aria-live")).toBe("assertive");
  });

  it("has aria-atomic=true on both", () => {
    render(<LiveRegion politeness="polite" message="test" label="test-region" />);
    const region = screen.getByRole("status", { name: "test-region" });
    expect(region.getAttribute("aria-atomic")).toBe("true");
  });
});

describe("HudLiveRegions — composite", () => {
  it("renders both regions with correct politeness", () => {
    render(
      <HudLiveRegions
        politeMessage="Phase 2 started"
        assertiveMessage="Gate D raised — CRITICAL"
      />
    );

    const politeRegion = screen.getByRole("status", { name: "Pipeline status updates" });
    const assertiveRegion = screen.getByRole("status", { name: "Critical gate escalations" });

    expect(politeRegion.getAttribute("aria-live")).toBe("polite");
    expect(assertiveRegion.getAttribute("aria-live")).toBe("assertive");
  });

  it("polite region is NOT assertive (no cross-contamination)", () => {
    render(<HudLiveRegions politeMessage="Phase 1 done" assertiveMessage="" />);
    const politeRegion = screen.getByRole("status", { name: "Pipeline status updates" });
    expect(politeRegion.getAttribute("aria-live")).not.toBe("assertive");
  });

  it("assertive region is NOT polite (no cross-contamination)", () => {
    render(<HudLiveRegions politeMessage="" assertiveMessage="CRITICAL: Gate D" />);
    const assertiveRegion = screen.getByRole("status", { name: "Critical gate escalations" });
    expect(assertiveRegion.getAttribute("aria-live")).not.toBe("polite");
  });
});

describe("announce.ts — urgency split", () => {
  it("maps critical severity to assertive", async () => {
    const { gateUrgency } = await import("../announce");
    expect(gateUrgency("critical")).toBe("assertive");
  });

  it("maps non-critical severities to polite", async () => {
    const { gateUrgency } = await import("../announce");
    expect(gateUrgency("info")).toBe("polite");
    expect(gateUrgency("low")).toBe("polite");
    expect(gateUrgency("medium")).toBe("polite");
    expect(gateUrgency("high")).toBe("polite");
  });
});
