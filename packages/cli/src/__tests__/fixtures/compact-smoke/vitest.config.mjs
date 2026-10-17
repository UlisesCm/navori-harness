import { defineConfig } from "vitest/config";
import CompactReporter from "../../../../vitest.reporter.ts";

// Tiny isolated config for compact-reporter.test.ts: only the *.fix.ts files here.
export default defineConfig({
  test: { include: ["*.fix.ts"], reporters: [new CompactReporter()], silent: "passed-only" },
});
