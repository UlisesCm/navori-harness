import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Issue #75 — findReferencingRepos must honor `progress.dir` /
 * `progress.currentFile` from each repo's navori.config.json instead of
 * hardcoding `progress/current.md`, falling back to the defaults when the
 * config is missing or unreadable.
 *
 * Issue #83 — lifecycle coverage (create/archive/unarchive/delete/list) and
 * the regex-escaping fix. These need a workspace registry, so safeHomedir is
 * mocked to a throwaway home.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const {
  findReferencingRepos,
  createTicket,
  archiveTicket,
  unarchiveTicket,
  deleteTicket,
  listTickets,
  ticketsDir,
  findTicket,
  TicketError,
} = await import("../tickets.ts");
const { writeWorkspace } = await import("../workspace.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-tickets-"));
  home.dir = mkdtempSync(join(tmpdir(), "navori-tickets-home-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function seedWorkspace(name = "ws"): void {
  writeWorkspace({ name, ticketsDir: "tickets", defaults: {}, repos: [] });
}

function makeRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  return repo;
}

function writeCurrent(repo: string, relDir: string, file: string, content: string): void {
  mkdirSync(join(repo, relDir), { recursive: true });
  writeFileSync(join(repo, relDir, file), content, "utf-8");
}

describe("findReferencingRepos", () => {
  it("scans progress/current.md by default (no config)", () => {
    const repo = makeRepo("plain");
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-1\notra línea\n");

    const refs = findReferencingRepos([repo], "TICK-1");
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe(repo);
    expect(refs[0].matches).toEqual(["ticket: TICK-1"]);
  });

  it("honors progress.dir / progress.currentFile from navori.config.json", () => {
    const repo = makeRepo("custom");
    writeFileSync(
      join(repo, "navori.config.json"),
      JSON.stringify({
        name: "custom",
        engines: ["claude"],
        preset: "custom",
        progress: { dir: "state", currentFile: "session.md" },
      }),
      "utf-8",
    );
    writeCurrent(repo, "state", "session.md", "workspace://ws/tickets/TICK-2\n");
    // A stray default-path file must NOT be scanned when the config points elsewhere.
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-2\n");

    const refs = findReferencingRepos([repo], "TICK-2");
    expect(refs).toHaveLength(1);
    expect(refs[0].matches).toEqual(["workspace://ws/tickets/TICK-2"]);
  });

  it("falls back to the default path when the config is unreadable", () => {
    const repo = makeRepo("broken");
    writeFileSync(join(repo, "navori.config.json"), "{ not json", "utf-8");
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-3\n");

    const refs = findReferencingRepos([repo], "TICK-3");
    expect(refs).toHaveLength(1);
    expect(refs[0].matches).toEqual(["ticket: TICK-3"]);
  });

  it("falls back to the default path when the config fails validation", () => {
    const repo = makeRepo("invalid");
    writeFileSync(join(repo, "navori.config.json"), JSON.stringify({ name: 42 }), "utf-8");
    writeCurrent(repo, "progress", "current.md", "ticket: TICK-4\n");

    const refs = findReferencingRepos([repo], "TICK-4");
    expect(refs).toHaveLength(1);
  });

  it("skips repos whose current file does not exist or does not match", () => {
    const missing = makeRepo("missing");
    const noMatch = makeRepo("no-match");
    writeCurrent(noMatch, "progress", "current.md", "ticket: OTHER-9\n");

    expect(findReferencingRepos([missing, noMatch], "TICK-5")).toEqual([]);
  });

  it("treats an id with regex metacharacters literally (#83)", () => {
    const repo = makeRepo("meta");
    writeCurrent(repo, "progress", "current.md", "ticket: BNM-1.2\notra\n");
    // The "." must not match any char — "BNMX1X2" would falsely match a raw regex.
    const decoy = makeRepo("decoy");
    writeCurrent(decoy, "progress", "current.md", "ticket: BNMX1X2\n");

    const refs = findReferencingRepos([repo, decoy], "BNM-1.2");
    expect(refs.map((r) => r.path)).toEqual([repo]);
  });

  it("does not throw on an id with an unbalanced regex token (#83)", () => {
    const repo = makeRepo("paren");
    writeCurrent(repo, "progress", "current.md", "nada relevante\n");
    expect(() => findReferencingRepos([repo], "A(B")).not.toThrow();
  });
});

describe("ticket lifecycle (#83)", () => {
  describe("createTicket", () => {
    it("writes a ticket with the given title and returns an active summary", () => {
      seedWorkspace();
      const t = createTicket("ws", "BNM-1", "Arreglar login");
      expect(t.state).toBe("active");
      expect(t.title).toBe("Arreglar login");
      expect(existsSync(t.path)).toBe(true);
    });

    it("defaults the title to the id when empty/whitespace", () => {
      seedWorkspace();
      expect(createTicket("ws", "BNM-2", "   ").title).toBe("BNM-2");
      expect(createTicket("ws", "BNM-3").title).toBe("BNM-3");
    });

    it("rejects an invalid id", () => {
      seedWorkspace();
      expect(() => createTicket("ws", "bad id!")).toThrow(TicketError);
    });

    it("rejects a duplicate id", () => {
      seedWorkspace();
      createTicket("ws", "BNM-4");
      expect(() => createTicket("ws", "BNM-4")).toThrow(/already exists/);
    });
  });

  describe("archive / unarchive round-trip", () => {
    it("archives, then unarchives back to active", () => {
      seedWorkspace();
      createTicket("ws", "BNM-5");
      const archived = archiveTicket("ws", "BNM-5");
      expect(archived.state).toBe("archive");
      expect(findTicket("ws", "BNM-5")?.state).toBe("archive");

      const back = unarchiveTicket("ws", "BNM-5");
      expect(back.state).toBe("active");
      expect(findTicket("ws", "BNM-5")?.state).toBe("active");
    });

    it("archiving an already-archived ticket is a no-op", () => {
      seedWorkspace();
      createTicket("ws", "BNM-6");
      archiveTicket("ws", "BNM-6");
      expect(archiveTicket("ws", "BNM-6").state).toBe("archive");
    });

    it("unarchiving an active ticket is a no-op", () => {
      seedWorkspace();
      createTicket("ws", "BNM-7");
      expect(unarchiveTicket("ws", "BNM-7").state).toBe("active");
    });

    it("throws for a missing ticket", () => {
      seedWorkspace();
      expect(() => archiveTicket("ws", "GHOST")).toThrow(TicketError);
      expect(() => unarchiveTicket("ws", "GHOST")).toThrow(TicketError);
    });
  });

  describe("deleteTicket / listTickets", () => {
    it("deletes a ticket so it no longer lists", () => {
      seedWorkspace();
      createTicket("ws", "BNM-8");
      deleteTicket("ws", "BNM-8");
      expect(findTicket("ws", "BNM-8")).toBeNull();
    });

    it("lists active and archived tickets with their state", () => {
      seedWorkspace();
      createTicket("ws", "BNM-9");
      createTicket("ws", "BNM-10");
      archiveTicket("ws", "BNM-10");
      const byId = Object.fromEntries(listTickets("ws").map((t) => [t.id, t.state]));
      expect(byId).toEqual({ "BNM-9": "active", "BNM-10": "archive" });
    });
  });

  describe("ticketsDir", () => {
    it("throws for a workspace that does not exist", () => {
      expect(() => ticketsDir("nope")).toThrow(TicketError);
    });
  });
});
