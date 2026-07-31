import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Build the CLI once before the suite: the e2e specs spawn dist/index.js,
    // so a stale/missing dist would fail them for environmental reasons.
    globalSetup: ["./vitest.globalSetup.ts"],
    testTimeout: 15_000, // e2e specs spawn the CLI several times
    // Cap worker forks: the e2e specs each `spawnSync(dist/index.js)`, so at full
    // core count ~200 child processes run at once and exhaust file descriptors
    // (EMFILE/ENFILE), making the suite flaky (a manifest read then mis-reads as a
    // missing plugin → doctor exit 2). A bounded fork count keeps fd usage in
    // check without meaningfully slowing the (fast) unit tests (#281).
    pool: "forks",
    maxWorkers: 4,
    coverage: {
      // Spec 0003 §3.4.1 — pragmatic gate over src/lib/. The critical paths
      // (marker, config/schema, presets, scan, skill-meta) are well covered;
      // command-shell utils (workspace/tickets/migrate) and cosmetic output
      // (style) are intentionally NOT chased to 80%. The gate sits just below
      // the achieved level: it catches a real regression without being a
      // brittle "one deleted test breaks CI" tripwire.
      provider: "v8",
      include: ["src/lib/**"],
      // i18n.ts is a pure translation catalog: hundreds of function-valued
      // string builders (parameterized copy). v8 counts each as a function, so
      // its low exercised ratio drags the GLOBAL functions metric below the
      // gate even though it holds no branching logic worth a coverage bar. It's
      // data, not code — excluded on the same "don't chase cosmetic" principle
      // the threshold comment states. Key/locale parity is guarded by i18n.test.ts.
      exclude: ["src/lib/i18n.ts"],
      thresholds: {
        lines: 65,
        statements: 60,
        functions: 65,
        branches: 57,
      },
    },
  },
});
