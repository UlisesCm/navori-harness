// Preload (`node --import` / `bun --preload`) for the hook chain spawned by native-integration's
// liveOwnerFixture. The production hook caps (8 s CLI deadline, 11 s supervisor timer) are
// wall-clock, so CPU starvation fires them in CI (#1623). Only the two processes that own those
// caps are touched; the fake codex, git and the vitest worker are not:
//   cli        the `navori` CLI: Bun running src/index.ts (the owner's private bin/navori shim) or node
//   supervisor the inline node script of model-advisor.sh (stdin script, no argv[1])
//
// Default: Date.now()/new Date() freeze at load and timers >= LONG_TIMER_MS stay pending forever
// (unref'd). LONG_TIMER_MS = 1000 sits far under the smallest cap (8 s) yet above the short real
// timers the CLI uses (lock polls, I/O), which stay real.
// NAVORI_VCLOCK_EXPIRE=cli|supervisor expires that process' clock instead: after its first
// Date.now() the clock jumps 1 h (cli), or long timers fire at once (supervisor).
// NAVORI_VCLOCK_LOG=<file> appends the detected role so tests can prove the preload loaded.
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const LONG_TIMER_MS = 1000;
const script = process.argv[1];
const role =
  script === undefined
    ? "supervisor"
    : process.versions.bun || basename(script) === "navori"
      ? "cli"
      : undefined;

// Bun may read both NODE_OPTIONS and BUN_OPTIONS: patch once.
if (role && !globalThis.__navoriVirtualClock) {
  globalThis.__navoriVirtualClock = true;
  const expired = process.env.NAVORI_VCLOCK_EXPIRE === role;
  const logFile = process.env.NAVORI_VCLOCK_LOG;
  if (logFile) appendFileSync(logFile, `${role}${expired ? " expired" : ""}\n`);
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const start = realNow();
  let calls = 0;
  const now = () => {
    if (role !== "cli") return realNow();
    if (!expired) return start;
    return start + (calls++ === 0 ? 0 : 3_600_000);
  };
  if (role === "cli") {
    RealDate.now = now;
    // `new Date()` without arguments reads the same virtual clock; dated construction is untouched.
    globalThis.Date = new Proxy(RealDate, {
      construct: (target, args) => (args.length ? new target(...args) : new target(now())),
    });
  }
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (Number(ms) < LONG_TIMER_MS) return realSetTimeout(fn, ms, ...rest);
    if (expired) return realSetTimeout(fn, 1, ...rest);
    // Pending forever: a real, clearable handle that cannot fire nor hold the process open.
    return realSetTimeout(() => {}, 2 ** 31 - 1).unref();
  };
}
