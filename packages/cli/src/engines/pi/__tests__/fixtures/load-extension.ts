import { createRequire, stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { PI_EXTENSION_SOURCE } from "../../extension-source.ts";
import { PINNED_PI_VERSION } from "./pinned-pi-version.ts";

export type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;
export type Shell = () => { shell: string; args: string[] };

export const BASH: Shell = () => ({ shell: "/bin/bash", args: ["-c"] });

/** Loads the rendered extension with Pi stubbed and real node:* modules (the scripts really run). */
export function load(
  options: {
    shell?: Shell;
    env?: Record<string, string>;
    version?: string;
    /** Node IPC `process.send` of a child, to observe what it relays to its parent. */
    send?: (message: Record<string, unknown>, callback: (error: Error | null) => void) => void;
  } = {},
): Map<string, Handler> {
  const nodeRequire = createRequire(import.meta.url);
  const handlers = new Map<string, Handler>();
  const modules: Record<string, unknown> = {
    "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
    "@earendil-works/pi-coding-agent": {
      VERSION: options.version ?? PINNED_PI_VERSION,
      defineTool: (value: unknown) => value,
      getShellConfig: options.shell ?? BASH,
    },
  };
  const exports: { default?: (pi: unknown) => void } = {};
  const source = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  runInNewContext(source, {
    exports,
    require: (id: string): unknown => modules[id] ?? nodeRequire(id),
    process: {
      env: { ...process.env, NAVORI_PI_CHILD_DEPTH: "", NAVORI_PI_CHILD_ROLE: "", ...options.env },
      platform: process.platform,
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
      kill: process.kill.bind(process),
      getBuiltinModule: process.getBuiltinModule.bind(process),
      ...(options.send ? { send: options.send } : {}),
    },
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  exports.default?.({
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    on: (name: string, handler: Handler) => {
      // The first handler of an event is the bridge's: the later ones are context helpers.
      if (!handlers.has(name)) handlers.set(name, handler);
    },
    registerTool: () => {},
  });
  return handlers;
}
