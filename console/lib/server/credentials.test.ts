import { describe, it, expect, beforeEach } from "vitest";
import { stripServerCredentials, assertNoCredential, _resetCredentialState } from "./credentials";

beforeEach(() => _resetCredentialState());

describe("stripServerCredentials — boot-time credential isolation (T4b)", () => {
  it("deletes named + pattern-matched credential env, keeps harness/base vars, returns NAMES only", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-abcdefgh",
      NTFY_TOKEN: "tk_supersecret",
      DB_PASSWORD: "hunter2xx",
      HARNESS_LIVE: "1",
      NODE_ENV: "test",
    };
    const stripped = stripServerCredentials(env);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NTFY_TOKEN).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HARNESS_LIVE).toBe("1");
    expect(stripped.sort()).toEqual(["ANTHROPIC_API_KEY", "DB_PASSWORD", "NTFY_TOKEN"]);
  });

  it("assertNoCredential fails closed if a stripped secret VALUE reappears in a browser payload", () => {
    stripServerCredentials({ ANTHROPIC_API_KEY: "sk-ant-leakyvalue123" });
    expect(() => assertNoCredential({ note: "sk-ant-leakyvalue123" })).toThrow();
    expect(() => assertNoCredential({ ANTHROPIC_API_KEY: "x" })).toThrow(); // by name
    expect(() => assertNoCredential({ ok: true })).not.toThrow();
  });
});
