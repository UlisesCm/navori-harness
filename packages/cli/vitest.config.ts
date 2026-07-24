import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Build the CLI once before the suite: the e2e specs spawn dist/index.js,
    // so a stale/missing dist would fail them for environmental reasons.
    globalSetup: ["./vitest.globalSetup.ts"],
    testTimeout: 15_000, // e2e specs spawn the CLI several times
    coverage: {
      // Spec 0003 §3.4.1 — pragmatic gate over src/lib/. The critical paths
      // (marker, config/schema, presets, scan, skill-meta) are well covered;
      // command-shell utils (workspace/tickets/migrate) and cosmetic output
      // (style) are intentionally NOT chased to 80%. The gate sits just below
      // the achieved level: it catches a real regression without being a
      // brittle "one deleted test breaks CI" tripwire.
      provider: "v8",
      include: ["src/lib/**"],
      thresholds: {
        lines: 65,
        statements: 60,
        functions: 65,
        branches: 57,
      },
    },
  },
});
