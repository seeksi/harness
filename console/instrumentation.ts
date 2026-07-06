// console/instrumentation.ts
// Next.js calls register() once at server startup (before any request is served).
// We use it to enforce credential isolation at process start (threat model T4b):
// delete the metered API key + other credential env so the harness runs on the
// Max-plan subscription and there is no secret in process.env for any route/SSE
// path — or any spawned harness child — to reflect. Ported from web/instrumentation.ts.
import { stripServerCredentials } from "@/lib/server/credentials";

export function register(): void {
  // Unconditional: strip credentials in every runtime so no startup path leaves
  // them in process.env (don't gate on NEXT_RUNTIME).
  const stripped = stripServerCredentials();
  if (stripped.length > 0) {
    // Log NAMES only — never values.
    console.warn(`[security] stripped credential env at boot: ${stripped.join(", ")}`);
  }
}
