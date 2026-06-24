// Integration test config — two projects so node-env and jsdom-env suites
// coexist after the A/B/C lane merge. Node: reducer/store/persist/api/scene
// projection. jsdom: HUD DOM-mirror/aria + the SSE client (EventSource).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const alias = { "@": path.resolve(__dirname, ".") };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          globals: true,
          // Fresh module registry per file so the better-sqlite3 singleton resets.
          isolate: true,
          pool: "forks",
          include: ["**/*.test.ts"],
          exclude: ["node_modules/**", "hud/**", "lib/sse/**", "**/*.test.tsx"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "dom",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./vitest.setup.ts"],
          include: ["hud/**/*.test.{ts,tsx}", "lib/sse/**/*.test.ts", "**/*.test.tsx"],
          exclude: ["node_modules/**"],
        },
      },
    ],
  },
});
