import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only the backend package's tests. The Svelte UI in app/ is a nested
    // project with its own Vitest config (jsdom + the @sartools/feature-store
    // alias); run it from app/ with `cd app && npm test`.
    include: ["tests/**/*.test.ts"],
    exclude: ["app/**", "node_modules/**"],
  },
});
