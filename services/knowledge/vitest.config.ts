import { defineConfig } from "vitest/config";

/**
 * Local vitest config so `pnpm --filter @octopus/knowledge-service test`
 * runs from this package's cwd. The repo root config covers monorepo-wide
 * runs; this one scopes to services/knowledge/src and re-uses the root
 * setupFile via a relative path.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["../../tests/setup.ts"],
    environment: "node",
  },
});
