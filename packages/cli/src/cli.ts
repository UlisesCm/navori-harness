import { defineCommand } from "citty";
import { readCliVersion } from "./lib/render/bundled-assets.ts";

/**
 * Root command with lazy subcommands (spec 0055 R14, D8): each entry is an `import()` that
 * citty resolves only for the invoked subcommand, so the bundler emits one chunk per command
 * and a cold start loads just that command and its shared dependencies. Root `--help` resolves
 * every entry to list descriptions, so its output is unchanged.
 */
export const main = defineCommand({
  meta: {
    name: "navori",
    version: readCliVersion(),
    description: "Multi-agent harness + SDD scaffolder",
  },
  subCommands: {
    init: () => import("./commands/init.ts").then((m) => m.initCommand),
    add: () => import("./commands/add.ts").then((m) => m.addCommand),
    remove: () => import("./commands/remove.ts").then((m) => m.removeCommand),
    adopt: () => import("./commands/adopt.ts").then((m) => m.adoptCommand),
    configure: () => import("./commands/configure.ts").then((m) => m.configureCommand),
    update: () => import("./commands/update.ts").then((m) => m.updateCommand),
    refresh: () => import("./commands/refresh.ts").then((m) => m.refreshCommand),
    render: () => import("./commands/render.ts").then((m) => m.renderCommand),
    sync: () => import("./commands/sync.ts").then((m) => m.syncCommand),
    scan: () => import("./commands/scan.ts").then((m) => m.scanCommand),
    registry: () => import("./commands/registry.ts").then((m) => m.registryCommand),
    doctor: () => import("./commands/doctor.ts").then((m) => m.doctorCommand),
    status: () => import("./commands/status.ts").then((m) => m.statusCommand),
    bench: () => import("./commands/bench.ts").then((m) => m.benchCommand),
    workspace: () => import("./commands/workspace.ts").then((m) => m.workspaceCommand),
    ticket: () => import("./commands/ticket.ts").then((m) => m.ticketCommand),
    backup: () => import("./commands/backup.ts").then((m) => m.backupCommand),
    migrations: () => import("./commands/migrations.ts").then((m) => m.migrationsCommand),
    preset: () => import("./commands/preset.ts").then((m) => m.presetCommand),
    codex: () => import("./commands/codex.ts").then((m) => m.codexCommand),
    dominio: () => import("./commands/dominio.ts").then((m) => m.dominioCommand),
    audit: () => import("./commands/audit.ts").then((m) => m.auditCommand),
    receipt: () => import("./commands/receipt.ts").then((m) => m.receiptCommand),
    plan: () => import("./commands/plan.ts").then((m) => m.planCommand),
    spec: () => import("./commands/spec.ts").then((m) => m.specCommand),
    handoff: () => import("./commands/handoff.ts").then((m) => m.handoffCommand),
    master: () => import("./commands/master.ts").then((m) => m.masterCommand),
    tools: () => import("./commands/tools.ts").then((m) => m.toolsCommand),
    gate: () => import("./commands/gate.ts").then((m) => m.gateCommand),
  },
});
