import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { readFileSync } from "node:fs";
import {
  listTickets,
  findTicket,
  createTicket,
  findReferencingRepos,
  archiveTicket,
  unarchiveTicket,
  deleteTicket,
  TicketError,
} from "../lib/tickets.ts";
import { loadWorkspace } from "../lib/workspace.ts";
import { brand, dim, accent, color, sym, kv } from "../lib/style.ts";
import { tc, resolveLang, type Lang } from "../lib/i18n.ts";

/** Locale for ticket output: the workspace's default language, else the fallback. */
function wsLang(name: string): Lang {
  try {
    return resolveLang(loadWorkspace(name)?.defaults.language);
  } catch {
    return resolveLang(undefined);
  }
}

function handleTicketError(err: unknown): never {
  if (err instanceof TicketError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const listSubCommand = defineCommand({
  meta: {
    name: "list",
    description: "List tickets in a workspace",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    archive: { type: "boolean", description: "Include archived tickets" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run({ args }) {
    let tickets;
    try {
      tickets = listTickets(args.workspace as string);
    } catch (err) {
      handleTicketError(err);
    }
    const filtered = args.archive ? tickets : tickets.filter((t) => t.state === "active");
    if (args.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }
    const tr = tc(wsLang(args.workspace as string)).ticket;
    p.intro(brand(`ticket list ${accent(args.workspace as string)}`));
    if (filtered.length === 0) {
      p.log.info(tr.listEmpty(args.workspace as string));
      p.outro(dim(tr.done));
      return;
    }
    const lines = filtered.map((t) => {
      const badge = t.state === "archive" ? color.magenta(tr.archiveBadge) : "";
      return `  ${color.cyan(sym.bullet)} ${accent(t.id)}${badge}  ${t.title}`;
    });
    p.log.message(lines.join("\n"));
    p.outro(dim(tr.count(filtered.length)));
  },
});

const showSubCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show a ticket and which repos reference it",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    id: { type: "positional", description: "Ticket id", required: true },
    json: { type: "boolean", description: "Output as JSON" },
  },
  run({ args }) {
    let ticket;
    try {
      ticket = findTicket(args.workspace as string, args.id as string);
    } catch (err) {
      handleTicketError(err);
    }
    const tr = tc(wsLang(args.workspace as string)).ticket;
    if (!ticket) {
      process.stderr.write(tr.notFound(args.id as string, args.workspace as string));
      process.exit(1);
    }

    const ws = loadWorkspace(args.workspace as string);
    const repoPaths = (ws?.repos ?? []).map((r) => r.path);
    const referencing = findReferencingRepos(repoPaths, args.id as string);

    if (args.json) {
      const content = readFileSync(ticket.path, "utf-8");
      console.log(JSON.stringify({ ticket, referencing, content }, null, 2));
      return;
    }

    p.intro(brand(`ticket show ${accent(ticket.id)}`));
    p.log.message(
      kv([
        ["title", ticket.title],
        ["state", ticket.state],
        ["path", ticket.path],
      ]),
    );
    p.note(readFileSync(ticket.path, "utf-8"), tr.contentTitle);

    if (referencing.length === 0) {
      p.log.message(dim(tr.noReferences));
    } else {
      const refLines = referencing.flatMap((ref) => [
        `  ${color.cyan(sym.bullet)} ${ref.path}`,
        ...ref.matches.map((match) => `      ${dim(">")} ${dim(match)}`),
      ]);
      p.log.message(`${tr.referencedLabel}\n${refLines.join("\n")}`);
    }
    p.outro(dim(tr.done));
  },
});

const newSubCommand = defineCommand({
  meta: {
    name: "new",
    description: "Create a new ticket in a workspace",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    id: { type: "positional", description: "Ticket id (e.g. BNM-123)", required: true },
    title: { type: "string", description: "Ticket title (default: id)" },
  },
  async run({ args }) {
    const tr = tc(wsLang(args.workspace as string)).ticket;
    p.intro(brand(`ticket new ${accent(args.id as string)}`));

    // Validate the id BEFORE prompting for a title, otherwise the user
    // writes the title only to discover the id is rejected.
    const id = args.id as string;
    if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(id)) {
      p.cancel(tr.invalidId(id));
      process.exit(1);
    }

    let title = args.title;
    if (!title) {
      const value = await p.text({
        message: tr.titlePrompt,
        placeholder: id,
        defaultValue: id,
      });
      if (p.isCancel(value)) {
        p.cancel(tr.cancelled);
        process.exit(0);
      }
      title = value as string;
    }

    let ticket;
    try {
      ticket = createTicket(args.workspace as string, args.id as string, title);
    } catch (err) {
      if (err instanceof TicketError) {
        p.cancel(err.message);
        process.exit(1);
      }
      throw err;
    }
    p.log.success(tr.wrote(ticket.path));
    p.outro(tr.referenceHint(args.id as string));
  },
});

const archiveSubCommand = defineCommand({
  meta: {
    name: "archive",
    description: "Move a ticket to the _archive folder (reversible)",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    id: { type: "positional", description: "Ticket id", required: true },
  },
  run({ args }) {
    try {
      const tr = tc(wsLang(args.workspace as string)).ticket;
      const result = archiveTicket(args.workspace as string, args.id as string);
      p.intro(brand(`ticket archive ${accent(args.id as string)}`));
      p.log.success(tr.archived(dim(result.path)));
      p.outro(dim(tr.done));
    } catch (err) {
      if (err instanceof TicketError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  },
});

const unarchiveSubCommand = defineCommand({
  meta: {
    name: "unarchive",
    description: "Move an archived ticket back to the active folder",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    id: { type: "positional", description: "Ticket id", required: true },
  },
  run({ args }) {
    try {
      const tr = tc(wsLang(args.workspace as string)).ticket;
      const result = unarchiveTicket(args.workspace as string, args.id as string);
      p.intro(brand(`ticket unarchive ${accent(args.id as string)}`));
      p.log.success(tr.unarchived(dim(result.path)));
      p.outro(dim(tr.done));
    } catch (err) {
      if (err instanceof TicketError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  },
});

const deleteSubCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a ticket permanently",
  },
  args: {
    workspace: { type: "positional", description: "Workspace name", required: true },
    id: { type: "positional", description: "Ticket id", required: true },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const lang = wsLang(args.workspace as string);
    const tr = tc(lang).ticket;
    p.intro(brand(`ticket delete ${accent(args.id as string)}`));
    if (!args.yes) {
      const ok = await p.confirm({
        message: tr.deleteConfirm(args.id as string, args.workspace as string),
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel(tc(lang).common.aborted);
        return;
      }
    }
    try {
      deleteTicket(args.workspace as string, args.id as string);
      p.outro(tr.deleted);
    } catch (err) {
      if (err instanceof TicketError) {
        p.cancel(err.message);
        process.exit(1);
      }
      throw err;
    }
  },
});

export const ticketCommand = defineCommand({
  meta: {
    name: "ticket",
    description: "Manage tickets-as-files inside a workspace",
  },
  subCommands: {
    list: listSubCommand,
    show: showSubCommand,
    new: newSubCommand,
    archive: archiveSubCommand,
    unarchive: unarchiveSubCommand,
    delete: deleteSubCommand,
  },
});
