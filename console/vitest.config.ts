// Logic-only test suite (reducer, discovery, retention, notifier, health/staleness).
// Node environment throughout — no UI snapshots (per subtask spec: cover logic, not DOM).
// `isolate + forks` so the better-sqlite3 singleton resets between persistence files.
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    name: "node",
    environment: "node",
    globals: true,
    isolate: true,
    pool: "forks",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
