import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { HOST_CONTRACTS, hostContract } from "../host-contracts.ts";

/**
 * #647 — doctrine that asserts something the host does not do.
 *
 * Five defects of 2026-09-09/10 share that signature and NONE was found by a
 * mechanism; all five by accident. The repo already checks prose against
 * reality three ways — `hook-claims-vs-scripts` (an asset vs a hook script),
 * `cited-paths-exist` (a citation vs the render), `check-asset-commands` (a
 * cited subcommand vs the registry) — and every one of them compares an asset
 * against something NAVORI produces. That is precisely why they were blind:
 * in three of the five, navori's own code also acted on the false claim, so
 * the system was coherent with itself and wrong about the world.
 *
 * This suite adds the two checks that are objective enough to be worth having,
 * and refuses the ones that would need to guess:
 *
 *   1. REGISTRY DISCIPLINE — `host-contracts.ts` is the single place where a
 *      host behavior is recorded, and every entry must name who enforces it.
 *      An unenforced contract is allowed; an unenforced contract that does not
 *      SAY so is not.
 *   2. THE SHAPE THAT FAILS SILENTLY — a flat `.claude/skills/<x>.md`. The host
 *      never loads it and never complains, so nothing but a text check can find
 *      a claim that it works.
 *   3. SELF-FULFILLING VERIFICATION — an instruction inside file F that says to
 *      grep F for a token F contains. It can only ever succeed, so it is not a
 *      check; it is a check-shaped sentence.
 *
 * What this suite deliberately does NOT do is re-implement the host's
 * documentation. A test that restated the Settings precedence table would be a
 * copy that desynchronizes — the same error one level up, which is the error
 * #647 is about. Contracts that cannot be detected without guessing are
 * RECORDED, not detected, and say why in `enforcedBy`.
 */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const CLI_SRC = resolve(getCoreRoot(), "..", "cli", "src");
const REPO_ROOT = resolve(getCoreRoot(), "..", "..");

/** Every file under `dir` with one of `exts`, recursively. */
function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const rel = (path: string): string => relative(REPO_ROOT, path).split("\\").join("/");

describe("host contracts registry (#647)", () => {
  it("every contract carries a claim, a source, the defect and who enforces it", () => {
    for (const contract of HOST_CONTRACTS) {
      const where = `contract '${contract.id}'`;
      expect(contract.id, where).toMatch(/^[a-z0-9-]+$/);
      // A source that is a paraphrase is a copy waiting to desynchronize; these
      // lengths are the weakest bar that still rules out a bare "official docs".
      expect(contract.claim.length, `${where}: claim`).toBeGreaterThan(40);
      expect(contract.source.length, `${where}: source`).toBeGreaterThan(40);
      expect(contract.provedBy.length, `${where}: provedBy`).toBeGreaterThan(20);
      expect(contract.enforcedBy.length, `${where}: enforcedBy`).toBeGreaterThan(20);
    }
  });

  it("ids are unique and resolvable", () => {
    const ids = HOST_CONTRACTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(hostContract(id)?.id).toBe(id);
    expect(hostContract("nope")).toBeNull();
  });

  it("a contract nobody enforces says so, instead of implying a net", () => {
    // The failure this prevents is the second-order one #501 names: an agent
    // that believes a net exists stops doing the check itself. A contract may
    // legitimately have no automated enforcement — spec-driven trimming, a
    // single registrar — but it has to name what stands in for it.
    for (const contract of HOST_CONTRACTS) {
      const enforced = contract.enforcedBy;
      const admitsGap = /nothing|nobody|no automated/i.test(enforced);
      const namesEnforcer = /\.ts|\.sh|`|spec \d|doctor/i.test(enforced);
      expect(admitsGap || namesEnforcer, `contract '${contract.id}': ${enforced}`).toBe(true);
    }
  });
});

/**
 * A file allowed to name the flat shape, and why. Same discipline as
 * `cited-paths-exist`'s exception list: an exception must justify itself in
 * writing, so the list cannot quietly become the rule.
 */
interface FlatMentionException {
  readonly file: string;
  readonly reason: string;
}

const FLAT_SHAPE_ALLOWED: readonly FlatMentionException[] = [
  {
    file: "packages/cli/src/engines/claude/index.ts",
    reason:
      "the one-time migration that PRUNES the flat twin — it must name the shape it deletes, " +
      "and both comments state the directory form is the only one Claude Code discovers",
  },
  {
    file: "packages/cli/src/engines/codex/index.ts",
    reason:
      "a plugin may still DECLARE `injectInto` against the legacy flat path; the comment " +
      "names it as legacy, next to the directory form it prefers",
  },
  {
    file: "packages/core/core-assets/presets",
    reason:
      "every preset manifest declares `destRelPath: '.claude/skills/<id>.md'` and the Claude " +
      "engine NORMALIZES it to the directory form — verified by rendering `vite-react-ts` into " +
      "a temp repo, where `new-feature` lands at `.claude/skills/new-feature/SKILL.md`. The " +
      "field is stale data nobody honours, and `preset.ts` still generates it; fixing the 30 " +
      "manifests plus the generator is its own change, tracked separately. Listed here so the " +
      "contradiction stays visible instead of being silently excluded",
  },
  {
    file: "packages/cli/src/lib/claude-infra.ts",
    reason:
      "foreign-harness DETECTION inventories what sits on disk, and a flat file is on disk " +
      "whether or not the host loads it — counting it is the point",
  },
];

describe("the shape that fails silently: flat `.claude/skills/<x>.md` (#626, #647)", () => {
  /**
   * Matches the flat form and NOT the directory form. Placeholders count:
   * `<id>.md` is how doctrine writes it, and `<id>.md` is exactly what the
   * stale JSDoc in `skill-meta.ts` claimed navori supported.
   */
  const FLAT = /(?:~\/)?\.claude\/skills\/[A-Za-z0-9_<>*-]+\.md/g;

  /** Shipped doctrine plus navori's own source; test fixtures are excluded. */
  function scanned(): string[] {
    const assets = walk(CORE_ASSETS, [".md", ".sh", ".json"]);
    // Fixtures build BOTH shapes on purpose — the flat one to prove it is
    // pruned, rejected and reported. Excluding them is not a hole: what they
    // assert is the contract itself.
    const source = walk(CLI_SRC, [".ts"]).filter((f) => !f.includes("__tests__"));
    return [...assets, ...source];
  }

  it("no asset and no source claims the flat form works", () => {
    const offenders: string[] = [];
    for (const file of scanned()) {
      const relPath = rel(file);
      // Prefix match so an exception may cover a directory (the preset manifests).
      if (FLAT_SHAPE_ALLOWED.some((e) => relPath === e.file || relPath.startsWith(`${e.file}/`)))
        continue;
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(FLAT)) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${relPath}:${line} — ${match[0]}`);
      }
    }
    expect(
      offenders,
      "Claude Code loads a skill ONLY as `<name>/SKILL.md` (see host-contracts.ts, " +
        "'skills-load-shape'). The flat form fails SILENTLY, so prose that endorses it costs " +
        "months. Rewrite the mention, or add the file to FLAT_SHAPE_ALLOWED with a reason.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("every exception names a file that still mentions the shape", () => {
    // A stale exception is worse than none: it reads as coverage while guarding
    // a mention that no longer exists.
    for (const exception of FLAT_SHAPE_ALLOWED) {
      const full = join(REPO_ROOT, exception.file);
      const files = statSync(full).isDirectory() ? walk(full, [".md", ".json", ".ts"]) : [full];
      const mentions = files.reduce(
        (n, f) => n + [...readFileSync(f, "utf-8").matchAll(FLAT)].length,
        0,
      );
      expect(mentions, `stale exception: ${exception.file}`).toBeGreaterThan(0);
      expect(exception.reason.length, `exception ${exception.file}: reason`).toBeGreaterThan(30);
    }
  });
});

describe("self-fulfilling verification (#634, #647)", () => {
  /**
   * A `grep`/wrapper invocation naming a token and a target path. Kept crude on
   * purpose: the only case this suite judges is the tautological one below, and
   * a cleverer parser would start guessing at intent — which is what #647 says
   * not to build.
   */
  const GREP = /\bgrep\b[^\n`]*/g;

  /**
   * The tautology, stated so it needs no intent inference: an instruction that
   * lives in file F, telling the reader to grep F for a token F contains. The
   * command cannot come back empty, so the "check" always passes and detects
   * nothing.
   *
   * #634 bis: `leader.md` told the reader to run `grep -n codex-cross-review
   * leader.md` to find out whether cross-review was configured. The pointer it
   * searched for lives in that very file, one line above the instruction.
   *
   * Narrow by construction: a grep whose target is ANOTHER file is a locator,
   * which is legitimate and common (`grep -n 'navori:managed id=…' CLAUDE.md`).
   * Only self-targeting is provably useless.
   */
  function selfTargetingGreps(file: string, text: string): string[] {
    const self = basename(file);
    const found: string[] = [];
    for (const match of text.matchAll(GREP)) {
      const command = match[0];
      // Target: the last path-looking argument of the invocation.
      const paths = [...command.matchAll(/(?:^|\s)([\w./-]+\.(?:md|sh|json|txt))(?=\s|$)/g)].map(
        (m) => m[1] as string,
      );
      const target = paths.at(-1);
      if (target === undefined) continue;
      if (target !== self && !target.endsWith(`/${self}`)) continue;

      // The token: a quoted string, else the first bare word that is not a flag
      // and not the target itself.
      const quoted = command.match(/'([^']+)'|"([^"]+)"/);
      const token =
        quoted?.[1] ??
        quoted?.[2] ??
        command
          .replace(/^\s*grep\b/, "")
          .split(/\s+/)
          .find((w) => w !== "" && !w.startsWith("-") && w !== target);
      if (token === undefined || token.length < 3) continue;

      // No containment test, and that is the whole point: the INSTRUCTION lives
      // in the file it tells you to grep, so the literal it names is in that
      // file by the mere act of naming it. The match is guaranteed before the
      // reader runs anything. Testing `text.includes(token)` would look like a
      // safeguard and always be true — a self-fulfilling check inside the
      // self-fulfilling-check detector.
      found.push(`${rel(file)} — \`${command.trim()}\` (token: ${token})`);
    }
    return found;
  }

  it("no asset tells the reader to grep itself for a token it contains", () => {
    const offenders: string[] = [];
    for (const file of walk(CORE_ASSETS, [".md"])) {
      offenders.push(...selfTargetingGreps(file, readFileSync(file, "utf-8")));
    }
    expect(
      offenders,
      "A grep of the file that carries the instruction, for a token that file contains, " +
        "always succeeds — it proves nothing and reads like a check. Point it at the file " +
        "that would really carry the evidence.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("recognizes the #634 shape and spares a legitimate locator", () => {
    // Regression fixture, so the detector cannot rot into a no-op: the suite
    // above passes today because #634 removed the only instance, and a check
    // that has nothing to find must still prove it can find it.
    const selfCheck = "Para saber si hay cross-review: `grep -n codex-cross-review leader.md`.";
    expect(selfTargetingGreps("/x/leader.md", selfCheck)).toHaveLength(1);

    // A grep pointed at ANOTHER file is a locator: legitimate, and the common
    // case in this harness. Only self-targeting is provably useless.
    const locator = "Locate the block: `grep -n 'navori:managed id=\"agentes\"' CLAUDE.md`.";
    expect(selfTargetingGreps("/x/leader.md", locator)).toEqual([]);

    // Same instruction, same file, different token — still a tautology, because
    // the instruction itself put the token in the file.
    const other = "Confirm nothing is left: `grep -n obsolete-token leader.md`.";
    expect(selfTargetingGreps("/x/leader.md", other)).toHaveLength(1);
  });
});
