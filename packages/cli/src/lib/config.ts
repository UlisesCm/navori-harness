import { writeFileSync } from "node:fs";

export interface NavoriConfig {
  $schema?: string;
  name: string;
  workspace?: string;
  engines: string[];
  preset: string;
  branchBase: string;
}

export function writeConfig(path: string, config: Omit<NavoriConfig, "$schema">): void {
  const fullConfig: NavoriConfig = {
    $schema: "https://navori.dev/schema/navori.config.v1.json",
    ...config,
  };
  writeFileSync(path, JSON.stringify(fullConfig, null, 2) + "\n", "utf-8");
}
