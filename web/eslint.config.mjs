// web/eslint.config.mjs
// Flat config (ESLint 10). Replaces the legacy .eslintrc.json, which ESLint 10
// can no longer read. eslint-config-next 16 ships native flat-config arrays, so
// no FlatCompat shim is needed.
//
// The import-boundary zones (the parallel-build lane isolation — ADR 0001 / NOTES)
// are preserved verbatim from the old .eslintrc.json. The `import` plugin is
// already registered by the Next flat config, so this only adds the rule; it is
// scoped to ts/tsx (where Next's import registration applies) so the rule resolves.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// T9 sink patterns. `**/lib/...` (not `@/lib/...`) so BOTH the path-alias form and a
// relative `../../lib/...` import are caught; store-internal relative imports
// (`./store`, `./raf-flush`) don't contain `lib/` so stay allowed.
// Residual (accepted): specifier matching can't see dynamic import()/require(),
// `.ts`-extension specifiers, or re-export laundering — eslint is a convention
// tripwire here; the runtime controls (provenance/schema/credential gates) are the
// actual security boundary.
const STORE_IMPL = {
  group: ["**/lib/store/store", "**/lib/store/raf-flush"],
  message:
    "Client store impl is allowlisted (T9): only runtime/useRunSession.ts (the composition root) may import it. Everyone else uses the interface in lib/contract/store.ts.",
};
const HARNESS_SPAWN = {
  group: ["**/lib/daemon/harness-bridge"],
  message:
    "The harness spawn is allowlisted (T9): only lib/daemon/daemon.ts may import harness-bridge. Routes/UI never spawn directly.",
};
const AGENT_SPAWN = {
  group: ["**/lib/daemon/agent-bridge"],
  message:
    "The agent spawn (headless Claude Code) is allowlisted: only lib/daemon/daemon.ts may import agent-bridge. Routes/UI never spawn agents directly.",
};

export default [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "eslint.config.mjs"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Honor the repo's `_`-prefix convention for deliberately-unused bindings
      // (discarded reducer fields, signature-only params).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // ALLOWLIST (threat model §7 / T9): default-deny BOTH sensitive sinks. Sanctioned
      // files re-enable only their assigned sink in the override blocks below — a NEW
      // module can't slip past an enumerated denylist because the default is deny.
      "no-restricted-imports": ["error", { patterns: [STORE_IMPL, HARNESS_SPAWN, AGENT_SPAWN] }],
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./scene",
              from: "./hud",
              message:
                "Lane B (scene/**) must not import Lane C (hud/**). Both are pure projections of RunState; the scene never reads the DOM. Cross only via lib/contract/**.",
            },
            {
              target: "./hud",
              from: "./scene",
              message:
                "Lane C (hud/**) must not import Lane B (scene/**). Both are pure projections of RunState; the DOM never reads the scene. Cross only via lib/contract/**.",
            },
            {
              target: ["./scene", "./hud"],
              from: "./lib/store",
              except: ["./useRunState.ts"],
              message:
                "scene/** and hud/** must reach the store ONLY via the lib/contract/** interface (and hud via lib/store/useRunState.ts). Do not import the store implementation (lib/store/{store,raf-flush}.ts) directly.",
            },
            {
              target: ["./app", "./lib/contract", "./lib/daemon", "./lib/sse", "./ui", "./styles"],
              from: "./lib/store",
              // persist.ts is Lane A's server-side SQLite persistence (Node-only),
              // not the client rAF store implementation (store.ts/raf-flush.ts) — it
              // is legitimately imported by the control-plane routes + daemon. The
              // restriction targets only the client store impl.
              except: ["./useRunState.ts", "./persist.ts"],
              message:
                "lib/store/{store,raf-flush}.ts (the client store implementation) is importable only by scene/** and lib/store/useRunState.ts. Everyone else imports the interface from lib/contract/store.ts.",
            },
          ],
        },
      ],
    },
  },
  // HudShell's announcement effect intentionally diffs prev/next state to fire the
  // aria-live messages screen readers depend on — a deliberate, documented pattern,
  // not silent suppression.
  { files: ["hud/HudShell.tsx"], rules: { "react-hooks/set-state-in-effect": "off" } },
  // T9 allowlist — each sanctioned file may import ONLY its assigned sink, so it
  // still can't reach the other (per-sink, not a blanket rule-off):
  //   • runtime/useRunSession.ts — composition root: may import the store impl;
  //     the harness spawn stays banned.
  //   • lib/daemon/daemon.ts — single producer: may import the harness + agent
  //     spawns; the store impl stays banned.
  {
    files: ["runtime/useRunSession.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [HARNESS_SPAWN, AGENT_SPAWN] }] },
  },
  {
    files: ["lib/daemon/daemon.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [STORE_IMPL] }] },
  },
  // Test files legitimately wire across lane boundaries to construct scenarios
  // (e.g. a scene test that creates a real store, or a bridge spawn test). The
  // boundaries enforce PRODUCTION isolation; production files remain checked.
  {
    files: ["**/*.test.{ts,tsx}", "**/__tests__/**"],
    rules: { "import/no-restricted-paths": "off", "no-restricted-imports": "off" },
  },
];
