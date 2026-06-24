// web/lib/daemon/errors.ts
// Shared error type for the harness bridge + registry. Lives in its own module so
// registry.ts and harness-bridge.ts can both import it without a circular dep.

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

/** Invalid agent spec, or agent execution refused/failed (agent-exec threat model). */
export class AgentExecError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AgentExecError";
  }
}
