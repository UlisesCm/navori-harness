import { defineCommand, runMain } from "citty";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initCommand } from "./commands/init.ts";
import { renderCommand } from "./commands/render.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { syncCommand } from "./commands/sync.ts";
import { addCommand } from "./commands/add.ts";
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

function readVersion(): string {
  // dist/index.js → ../package.json (both in dev and published layouts)
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "..", "package.json"),
    resolve(here, "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

const main = defineCommand({
  meta: {
    name: "navori",
    version: readVersion(),
    description: "Multi-agent harness + SDD scaffolder",
  },
  subCommands: {
    init: initCommand,
    add: addCommand,
    configure: configureCommand,
    update: updateCommand,
    render: renderCommand,
    sync: syncCommand,
    scan: scanCommand,
    doctor: doctorCommand,
    status: statusCommand,
    bench: benchCommand,
    workspace: workspaceCommand,
    ticket: ticketCommand,
    backup: backupCommand,
    migrations: migrationsCommand,
    preset: presetCommand,
  },
});

runMain(main);
