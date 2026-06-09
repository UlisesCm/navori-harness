import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.ts";
import { renderCommand } from "./commands/render.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { syncCommand } from "./commands/sync.ts";
import { addCommand } from "./commands/add.ts";
import { workspaceCommand } from "./commands/workspace.ts";
import { ticketCommand } from "./commands/ticket.ts";
import { configureCommand } from "./commands/configure.ts";
import { updateCommand } from "./commands/update.ts";

const main = defineCommand({
  meta: {
    name: "navori-ai",
    version: "0.0.1",
    description: "Multi-agent harness + SDD scaffolder",
  },
  subCommands: {
    init: initCommand,
    add: addCommand,
    configure: configureCommand,
    update: updateCommand,
    render: renderCommand,
    sync: syncCommand,
    doctor: doctorCommand,
    workspace: workspaceCommand,
    ticket: ticketCommand,
  },
});

runMain(main);
