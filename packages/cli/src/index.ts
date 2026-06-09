import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.ts";
import { renderCommand } from "./commands/render.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { syncCommand } from "./commands/sync.ts";
import { addCommand } from "./commands/add.ts";

const main = defineCommand({
  meta: {
    name: "navori-ai",
    version: "0.0.1",
    description: "Multi-agent harness + SDD scaffolder",
  },
  subCommands: {
    init: initCommand,
    add: addCommand,
    render: renderCommand,
    sync: syncCommand,
    doctor: doctorCommand,
  },
});

runMain(main);
