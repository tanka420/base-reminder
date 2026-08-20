/**
 * vitest.config.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Enable globals (describe, it, expect) if needed — but we import explicitly
    globals: false,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // Isolate each test file (fresh module registry per file)
    isolate: true,
    // TypeScript path support via tsx
    pool: "forks",
  },
});
