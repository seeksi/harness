// web/lib/security/credentials.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  stripServerCredentials,
  assertNoCredential,
  _resetCredentialState,
} from "./credentials";

beforeEach(() => _resetCredentialState());

describe("stripServerCredentials (T4b)", () => {
  it("deletes the metered API key and other credential env, returns the names removed", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai",
      PATH: "/usr/bin", // non-credential survives
    };
    const stripped = stripServerCredentials(env);
    expect(stripped).toContain("ANTHROPIC_API_KEY");
    expect(stripped).toContain("OPENAI_API_KEY");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips unlisted but credential-NAMED env (pattern, not just the denylist)", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "ghp_longsecretvalue",
      DB_PASSWORD: "hunter2hunter2",
      SOME_SECRET: "longenoughsecret",
      HARNESS_REPO: "/srv/harness", // not credential-named → kept
      NODE_ENV: "test",
    };
    const stripped = stripServerCredentials(env).sort();
    expect(stripped).toEqual(["DB_PASSWORD", "GITHUB_TOKEN", "SOME_SECRET"]);
    expect(env.HARNESS_REPO).toBe("/srv/harness");
    expect(env.NODE_ENV).toBe("test");
  });

  it("is idempotent and returns [] when nothing is present", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(stripServerCredentials(env)).toEqual([]);
    expect(stripServerCredentials(env)).toEqual([]);
  });

  it("never returns or exposes the secret VALUE, only the name", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-secret-value" };
    const stripped = stripServerCredentials(env);
    expect(JSON.stringify(stripped)).not.toContain("sk-ant-secret-value");
  });
});

describe("assertNoCredential (T4b browser-facing guard)", () => {
  it("passes clean payloads (e.g. a RunState-shaped snapshot)", () => {
    expect(() =>
      assertNoCredential({ type: "hello", run: { task: { id: "r1", brief: "build x" } } })
    ).not.toThrow();
  });

  it("throws if a credential env name appears anywhere in the payload", () => {
    expect(() => assertNoCredential({ leak: { ANTHROPIC_API_KEY: "sk" } })).toThrow(
      /ANTHROPIC_API_KEY/
    );
    expect(() => assertNoCredential({ note: "see OPENAI_API_KEY" })).toThrow(/OPENAI_API_KEY/);
  });

  it("throws if a known stripped secret VALUE appears in the payload (not just its name)", () => {
    // Simulate boot stripping the real key, capturing its value as a fingerprint.
    stripServerCredentials({ ANTHROPIC_API_KEY: "sk-ant-aVeryLongSecretValue123" });
    // A payload that smuggled the value (under an innocuous field name) is rejected,
    // and the error never echoes the value.
    expect(() =>
      assertNoCredential({ run: { brief: "oops sk-ant-aVeryLongSecretValue123 leaked" } })
    ).toThrow(/credential value/);
    try {
      assertNoCredential({ x: "sk-ant-aVeryLongSecretValue123" });
    } catch (e) {
      expect((e as Error).message).not.toContain("sk-ant-aVeryLongSecretValue123");
    }
  });
});
