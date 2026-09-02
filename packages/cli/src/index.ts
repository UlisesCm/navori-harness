import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.ts";
import { renderCommand } from "./commands/render.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { syncCommand } from "./commands/sync.ts";
import { addCommand } from "./commands/add.ts";
import { removeCommand } from "./commands/remove.ts";
import { adoptCommand } from "./commands/adopt.ts";
import { workspaceCommand } from "./commands/workspace.ts";
import { ticketCommand } from "./commands/ticket.ts";
import { configureCommand } from "./commands/configure.ts";
import { updateCommand } from "./commands/update.ts";
import { backupCommand } from "./commands/backup.ts";
import { migrationsCommand } from "./commands/migrations.ts";
import { presetCommand } from "./commands/preset.ts";
import { scanCommand } from "./commands/scan.ts";
import { statusCommand } from "./commands/status.ts";
import { benchCommand } from "./commands/bench.ts";
import { registryCommand } from "./commands/registry.ts";
import { globalCommand } from "./commands/global.ts";
import { dominioCommand } from "./commands/dominio.ts";
import { auditCommand } from "./commands/audit.ts";
import { readCliVersion } from "./lib/bundled-assets.ts";

const main = defineCommand({
  meta: {
    name: "navori",
    version: readCliVersion(),
    description: "Multi-agent harness + SDD scaffolder",
  },
  subCommands: {
    init: initCommand,
    add: addCommand,
    remove: removeCommand,
    adopt: adoptCommand,
    configure: configureCommand,
    update: updateCommand,
    render: renderCommand,
    sync: syncCommand,
    scan: scanCommand,
    registry: registryCommand,
    doctor: doctorCommand,
    status: statusCommand,
    bench: benchCommand,
    workspace: workspaceCommand,
    ticket: ticketCommand,
    backup: backupCommand,
    migrations: migrationsCommand,
    preset: presetCommand,
    global: globalCommand,
    dominio: dominioCommand,
    audit: auditCommand,
  },
});

runMain(main);
