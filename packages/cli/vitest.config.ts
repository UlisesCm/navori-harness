import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Build the CLI once before the suite: the e2e specs spawn dist/index.js,
    // so a stale/missing dist would fail them for environmental reasons.
    globalSetup: ["./vitest.globalSetup.ts"],
    // Per-spec-file backup store, so no test writes to (or purges from) the
    // developer's real ~/.navori/backups (#404).
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15_000, // e2e specs spawn the CLI several times
    // Cap worker forks: the e2e specs each `spawnSync(dist/index.js)`, so at full
    // core count ~200 child processes run at once and exhaust file descriptors
    // (EMFILE/ENFILE), making the suite flaky (a manifest read then mis-reads as a
    // missing plugin → doctor exit 2). A bounded fork count keeps fd usage in
    // check without meaningfully slowing the (fast) unit tests (#281).
    pool: "forks",
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      // #504 — INSTRUMENT everything, GATE what the bar was set for.
      //
      // The include used to be `src/lib/**`, so `src/commands/**` and
      // `src/engines/**` were not measured at all: a whole feature at 0% (audit,
      // #503) could not fail the gate, and could not even be SEEN in the report.
      // Widening the include measures them; the aggregate bar below stays scoped
      // to src/lib/ with its original numbers, because the whole tree sits far
      // under them (58.6% statements measured) and re-baselining the bar down to
      // fit would trade a real gate for a decorative one.
      include: ["src/**/*.ts"],
      // i18n.ts is a pure translation catalog: hundreds of function-valued
      // string builders (parameterized copy). v8 counts each as a function, so
      // its low exercised ratio drags the functions metric below the gate even
      // though it holds no branching logic worth a coverage bar. It's data, not
      // code — excluded on the same "don't chase cosmetic" principle the
      // threshold comment states. Key/locale parity is guarded by i18n.test.ts.
      // The `__tests__` trees are the suite itself, not the product.
      exclude: ["src/lib/i18n.ts", "src/**/__tests__/**"],
      // `json-summary` feeds scripts/check-coverage-floor.mjs, which catches the
      // shape this aggregate cannot: a single module at 0% dilutes into ~3,300
      // statements and never moves the average.
      reporter: ["text", "json-summary"],
      thresholds: {
        // Spec 0003 §3.4.1 — pragmatic gate over src/lib/. The critical paths
        // (marker, config/schema, presets, scan, skill-meta) are well covered;
        // command-shell utils (workspace/tickets) and cosmetic output (style)
        // are intentionally NOT chased to 80%. The gate sits just below the
        // achieved level: it catches a real regression without being a brittle
        // "one deleted test breaks CI" tripwire.
        //
        // A GLOB group, not the global one: with the include widened, a global
        // aggregate would average src/lib/ together with commands/ and engines/
        // and force these numbers down. Vitest skips the global check when no
        // top-level lines/statements/functions/branches are set.
        "src/lib/**": {
          lines: 65,
          statements: 60,
          functions: 65,
          branches: 57,
        },
      },
    },
  },
});
