// web/lib/security/credentials.ts
// Credential isolation (threat model §7 / T4b). The server is the SOLE credential
// holder and the browser must NEVER see a credential. Invariants:
//
// 1. Credential env is deleted at process start — ANTHROPIC_API_KEY above all
//    (forces the Max-plan subscription, never a metered key), plus anything whose
//    NAME looks credential-ish. Deleting them means there is nothing in process.env
//    for any route/SSE path to accidentally reflect.
// 2. The stripped VALUES are fingerprinted in memory (never logged, never
//    serialized) so `assertNoCredential(payload)` can fail-closed if a secret value
//    — not just its env name — ever appears in something bound for the browser.
//
// Defense in depth on top of the SSE schema whitelist (T4): the wire only carries
// whitelisted event fields, but stripping + value-fingerprinting removes the secret
// at the source and catches a leak through any future code path.

// Explicit must-strip names (the metered API key is load-bearing) ...
const CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
];
// ... plus any env whose NAME matches a credential-ish pattern ("other credential
// env"). The harness's own vars (HARNESS_*, NEXT_*, NODE_ENV, PATH) do not match.
const CREDENTIAL_NAME = /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i;

// Fingerprints of stripped secret values — memory-only, never logged or serialized.
// Only values long enough to be real secrets are remembered (avoids false positives).
const knownSecretValues = new Set<string>();
const MIN_SECRET_LEN = 8;

function isCredentialName(name: string): boolean {
  return CREDENTIAL_ENV.includes(name) || CREDENTIAL_NAME.test(name);
}

/**
 * Delete credential env vars from the running process and fingerprint their values.
 * Idempotent; returns the NAMES that were present and removed (never values).
 * Call once at process start (instrumentation.register).
 */
export function stripServerCredentials(
  env: Record<string, string | undefined> = process.env
): string[] {
  const stripped: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isCredentialName(name)) continue;
    const value = env[name];
    if (value && value.length >= MIN_SECRET_LEN) knownSecretValues.add(value);
    delete env[name];
    stripped.push(name);
  }
  return stripped;
}

/**
 * Fail-closed guard for the browser-facing serialization boundary (SSE `hello`
 * snapshot, JSON responses). Throws if the payload references a credential env NAME
 * or contains a known stripped secret VALUE. The error never includes the value.
 */
export function assertNoCredential(value: unknown): void {
  const json = JSON.stringify(value);
  if (json === undefined) return;
  for (const name of CREDENTIAL_ENV) {
    if (json.includes(name)) {
      throw new Error(`refusing to serialize: payload references credential env name ${name}`);
    }
  }
  for (const secret of knownSecretValues) {
    if (json.includes(secret)) {
      throw new Error("refusing to serialize: payload contains a known credential value");
    }
  }
}

/** Test-only: clear the in-memory secret-value fingerprints between cases. */
export function _resetCredentialState(): void {
  knownSecretValues.clear();
}
