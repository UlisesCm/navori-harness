import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.ts";
import { renderCommand } from "./commands/render.ts";

const main = defineCommand({
  meta: {
    name: "navori-ai",
    version: "0.0.1",
    description: "Multi-agent harness + SDD scaffolder",
  },
  subCommands: {
    init: initCommand,
    render: renderCommand,
  },
});

runMain(main);
