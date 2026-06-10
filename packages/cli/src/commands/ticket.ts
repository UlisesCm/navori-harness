import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { readFileSync } from "node:fs";
import {
  listTickets,
  findTicket,
  createTicket,
  findReferencingRepos,
  archiveTicket,
  deleteTicket,
  TicketError,
} from "../lib/tickets.ts";
import { loadWorkspace } from "../lib/workspace.ts";

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
    if (filtered.length === 0) {
      console.log(`No tickets in workspace '${args.workspace}'. Create one with 'navori ticket new ${args.workspace} <id>'.`);
      return;
    }
    for (const t of filtered) {
      const badge = t.state === "archive" ? " [archive]" : "";
      console.log(`  ${t.id}${badge}  ${t.title}`);
    }
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
    if (!ticket) {
      process.stderr.write(
        `Ticket '${args.id}' not found in workspace '${args.workspace}'.\n` +
          `Create it with: navori ticket new ${args.workspace} ${args.id}\n`,
      );
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

    console.log(`Ticket: ${ticket.id}`);
    console.log(`  title       : ${ticket.title}`);
    console.log(`  state       : ${ticket.state}`);
    console.log(`  path        : ${ticket.path}`);
    console.log("");
    console.log("--- Content ---");
    console.log(readFileSync(ticket.path, "utf-8"));
    console.log("--- Referenced in ---");
    if (referencing.length === 0) {
      console.log("  (no repo's progress/current.md mentions this ticket)");
    } else {
      for (const ref of referencing) {
        console.log(`  ${ref.path}`);
        for (const match of ref.matches) {
          console.log(`    > ${match}`);
        }
      }
    }
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
    p.intro(`navori ticket new ${args.id}`);

    // Validate the id BEFORE prompting for a title, otherwise the user
    // writes the title only to discover the id is rejected.
    const id = args.id as string;
    if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(id)) {
      p.cancel(`Invalid ticket id '${id}'. Use letters, digits, hyphens, underscores (must start alphanumeric).`);
      process.exit(1);
    }

    let title = args.title;
    if (!title) {
      const value = await p.text({
        message: "Ticket title",
        placeholder: id,
        defaultValue: id,
      });
      if (p.isCancel(value)) {
        p.cancel("Cancelled");
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
    p.log.success(`Wrote ${ticket.path}`);
    p.outro(`Reference it from a repo's progress/current.md with:\n  ticket: ${args.id}`);
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
      const result = archiveTicket(args.workspace as string, args.id as string);
      console.log(`Archived: ${result.path}`);
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
    p.intro(`navori ticket delete ${args.id}`);
    if (!args.yes) {
      const ok = await p.confirm({
        message: `Permanently delete ticket '${args.id}' from workspace '${args.workspace}'?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }
    try {
      deleteTicket(args.workspace as string, args.id as string);
      p.outro("Deleted");
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
    delete: deleteSubCommand,
  },
});
