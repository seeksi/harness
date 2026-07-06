import { describe, it, expect } from "vitest";
import { sanitizeProjectId, projectLabel } from "./format";

describe("sanitizeProjectId — DOM path-leak guard", () => {
  it("passes an opaque slug through unchanged", () => {
    expect(sanitizeProjectId("harness-a1b2c3d4")).toBe("harness-a1b2c3d4");
  });

  it("reduces a legacy absolute posix path to its basename", () => {
    expect(sanitizeProjectId("/home/alter/HARNESS")).toBe("HARNESS");
  });

  it("reduces a legacy absolute path with a trailing slash", () => {
    expect(sanitizeProjectId("/home/alter/HARNESS/")).toBe("HARNESS");
  });

  it("reduces a legacy Windows-style absolute path", () => {
    expect(sanitizeProjectId("C:\\Users\\alter\\HARNESS")).toBe("HARNESS");
  });

  it("never returns a string containing a path separator", () => {
    const out = sanitizeProjectId("/a/b/c/d");
    expect(out).not.toContain("/");
    expect(out).not.toContain("\\");
  });
});

describe("projectLabel — prefers the human name, else a sanitized id", () => {
  it("uses projectName when present", () => {
    expect(projectLabel("/home/alter/HARNESS", "HARNESS")).toBe("HARNESS");
  });

  it("falls back to the sanitized id when no name is given", () => {
    expect(projectLabel("/home/alter/HARNESS")).toBe("HARNESS");
  });

  it("falls back to the sanitized id when the name is blank", () => {
    expect(projectLabel("/home/alter/HARNESS", "  ")).toBe("HARNESS");
  });

  it("never leaks a raw absolute path even without a name", () => {
    expect(projectLabel("/home/alter/secret-project")).not.toContain("/home/");
  });
});
