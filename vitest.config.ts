import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],

    // --- CI Safety Limits ---
    // Default per-test timeout: 5s (tests needing more must declare it explicitly)
    // This catches slow tests early and forces authors to justify long timeouts.
    testTimeout: 5000,

    // afterEach/beforeEach hook timeout: 5s
    // process-tool cleanup (parallel kills) should complete well within this.
    hookTimeout: 5000,

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/skills/**",
        "src/cli/**",
        "src/services/meeting-analysis.ts",
        "dist/**",
        "node_modules/**",
        "bin/**",
      ],
      thresholds: {
        statements: 37.5,
        lines: 37.5,
        branches: 60,
        functions: 40,
      },
    },
  },
});
