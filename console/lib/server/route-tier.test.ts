import { describe, it, expect } from "vitest";
import { routeModel } from "./route-tier";

// The heuristic is ported VERBATIM from .claude/skills/route-cost/route.py — these cases
// exercise the same TOP→opus / CHEAP→haiku / default→sonnet contract that route.py's
// route() returns (top / cheap / default tiers), including its case-fold and word-boundary
// semantics. If these fail after a route.py edit, the two regexes have drifted out of sync.
describe("routeModel — keyword tiering (route.py parity)", () => {
  it("TOP keywords → opus (hard reasoning / correctness-critical)", () => {
    expect(routeModel("review the security threat model")).toBe("opus");
    expect(routeModel("architect the new subsystem")).toBe("opus");
    expect(routeModel("reconcile the cross-review findings")).toBe("opus");
    expect(routeModel("debug the root-cause of the crash")).toBe("opus");
    expect(routeModel("plan the schema migration")).toBe("opus"); // "migrat" stem
    expect(routeModel("fix the tricky concurrency bug")).toBe("opus"); // tricky + concurren
    expect(routeModel("design the API")).toBe("opus"); // design\b boundary
  });

  it("CHEAP keywords → haiku (mechanical / read-only)", () => {
    expect(routeModel("write docs for the README")).toBe("haiku");
    expect(routeModel("scaffold the boilerplate module")).toBe("haiku");
    expect(routeModel("rename the variable and run lint")).toBe("haiku");
    expect(routeModel("format the file")).toBe("haiku");
    expect(routeModel("explore and search the codebase")).toBe("haiku");
    expect(routeModel("fix the typo in the comment")).toBe("haiku");
    expect(routeModel("read the config")).toBe("haiku"); // read\b boundary
  });

  it("no keyword → sonnet (ordinary implementation)", () => {
    expect(routeModel("implement the fetch wrapper")).toBe("sonnet");
    expect(routeModel("add a button to the toolbar")).toBe("sonnet");
    expect(routeModel("wire up the event handler")).toBe("sonnet");
  });

  it("case-insensitive (route.py lower-cases the input)", () => {
    expect(routeModel("REVIEW THE SECURITY MODEL")).toBe("opus");
    expect(routeModel("Write DOCS")).toBe("haiku");
    expect(routeModel("Implement The Feature")).toBe("sonnet");
  });

  it("TOP wins over CHEAP when both match (route.py precedence)", () => {
    // "review" (TOP) + "docs" (CHEAP) in one brief ⇒ TOP is checked first.
    expect(routeModel("review the docs")).toBe("opus");
  });

  it("word boundaries mirror route.py exactly (\\btest\\b both-sided, read\\b trailing-only)", () => {
    expect(routeModel("write a test for the parser")).toBe("haiku"); // \btest\b
    expect(routeModel("update the latest release notes")).toBe("sonnet"); // "latest" ≠ \btest\b
    // route.py's CHEAP uses `read\b` (trailing boundary ONLY, no leading \b): any "...read"
    // word tail matches. "proofread" hits it; "reading" (no trailing boundary) does not.
    expect(routeModel("proofread the copy")).toBe("haiku"); // "...read" tail matches read\b
    expect(routeModel("reading the file")).toBe("sonnet"); // "read"+"ing" ⇒ no trailing \b
    expect(routeModel("read the file")).toBe("haiku"); // read\b
  });
});
