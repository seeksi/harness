// Lane B test config. Maps the `@/*` alias (tsconfig paths) for vitest and scopes
// the run to Lane B's own test files so it doesn't pull in other lanes' suites.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/store/**/*.test.ts", "scene/**/*.test.ts"],
  },
});
