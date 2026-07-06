// console/lib/bridge/errors.ts
// Shared error types for the harness bridge + registry + agent sandbox. Own module so
// registry.ts, harness-bridge.ts, and lib/sandbox/* can all import without a circular
// dependency. (Ported — not imported — from web/lib/daemon/errors.ts.)

export class HarnessArgError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HarnessArgError";
  }
}

/** A spawned harness child exceeded its deadline and was killed (threat model T6). */
export class HarnessTimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HarnessTimeoutError";
  }
}

/**
 * An agent-exec request was refused or built from invalid/unminted input (the sandbox's
 * fail-closed error). Thrown by lib/sandbox/* on a bad spec, a disabled gate, a refused
 * direct-mode, or a containment/provenance violation — NEVER carries a prompt/secret.
 */
export class AgentExecError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AgentExecError";
  }
}
