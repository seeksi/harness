// console/eslint.config.mjs
// Import-boundary enforcement (threat model §7 / T9), ported from web/eslint.config.mjs and
// adapted to the console's layout. Default-DENY the two security-critical sinks; only the
// enumerated allowlist files re-enable their assigned sink — a NEW module can't slip past an
// enumerated denylist because the default is deny.
//
// Standalone flat config (no eslint-config-next preset import) so it carries no dependency
// the console doesn't ship; the rule is the security-relevant part. `next build` does not run
// this (ESLint is opt-in and not installed here); it documents + enforces the boundary for
// anyone who runs `eslint` directly.
//
// `**/lib/...` (not `@/lib/...`) so BOTH the path-alias form and a relative `../../lib/...`
// import are caught. Residual (accepted): specifier matching can't see dynamic
// import()/require() or re-export laundering — the runtime controls (provenance/schema/
// credential/env gates) are the actual security boundary; this is a convention tripwire.

const HARNESS_SPAWN = {
  group: ["**/lib/bridge/harness-bridge"],
  message:
    "The harness spawn is allowlisted (T9): only lib/server/daemon.ts may import harness-bridge. Routes/UI never spawn directly.",
};
const DAEMON = {
  group: ["**/lib/server/daemon"],
  message:
    "The live run orchestrator is allowlisted (T9): only app/api/runs/route.ts may import lib/server/daemon. Everyone else observes runs via persistence / the SSE stream.",
};

export default [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "eslint.config.mjs"] },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Default-deny BOTH sinks; sanctioned files re-enable only their assigned sink below.
      "no-restricted-imports": ["error", { patterns: [HARNESS_SPAWN, DAEMON] }],
    },
  },
  // lib/server/daemon.ts — the single producer: may import the harness spawn; still can't
  // be imported by anyone but the run route (the DAEMON pattern above still bans importing
  // daemon FROM here, which daemon never does).
  {
    files: ["lib/server/daemon.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [DAEMON] }] },
  },
  // app/api/runs/route.ts — the composition caller: may import the daemon; the harness spawn
  // stays banned (routes never spawn harness.sh directly).
  {
    files: ["app/api/runs/route.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [HARNESS_SPAWN] }] },
  },
  // Tests legitimately wire across boundaries to construct scenarios; production stays checked.
  {
    files: ["**/*.test.{ts,tsx}", "**/__tests__/**"],
    rules: { "no-restricted-imports": "off" },
  },
];
