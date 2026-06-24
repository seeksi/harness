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
  // Tracked deferrals (NOT silent suppression). The scene increment (C11) replaces
  // NodeGraph's read-snapshot-in-render with proper imperative mesh reconciliation;
  // HudShell's announcement effect intentionally diffs prev/next state to fire the
  // aria-live messages screen readers depend on.
  { files: ["scene/NodeGraph.tsx"], rules: { "react-hooks/refs": "off" } },
  { files: ["hud/HudShell.tsx"], rules: { "react-hooks/set-state-in-effect": "off" } },
];
