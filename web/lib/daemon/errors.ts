// web/lib/daemon/errors.ts
// Shared error type for the harness bridge + registry. Lives in its own module so
// registry.ts and harness-bridge.ts can both import it without a circular dep.

export class HarnessArgError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HarnessArgError";
  }
}
