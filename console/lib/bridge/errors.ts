// console/lib/bridge/errors.ts
// Shared error types for the harness bridge + registry. Own module so registry.ts and
// harness-bridge.ts can both import without a circular dependency. (Ported — not
// imported — from web/lib/daemon/errors.ts; AgentExecError dropped, no agent-exec here.)

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
