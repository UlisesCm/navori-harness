import { defineCommand } from "citty";
import { join } from "node:path";
import { readConfig } from "../lib/config/config.ts";
import { resolveLang, toolNoticeText } from "../lib/i18n.ts";
import { ackToolNotices, prepareToolNotices } from "../lib/primitives/tool-version-notice.ts";

/**
 * Output contract v1, read by the SessionStart hook: the FIRST line is exactly
 * `#navori-tool-notice v1 ack=<pluginId>@<x.y.z>[,...]`, followed by one localized line per
 * tool. With nothing to say the command prints nothing at all. The hook discards any output
 * that does not start with this sentinel, which is what keeps an older navori (whose usage
 * banner would land on stdout for an unknown subcommand) out of the model's context.
 */
export const TOOL_NOTICE_SENTINEL = "#navori-tool-notice v1 ack=";

/**
 * `notice` is a MACHINE command for the SessionStart hook: it reads the per-machine release
 * cache (never the network), reserves the daily refresh for a detached worker, and prints the
 * notices still pending. It never throws and always exits 0. `--ack` stamps delivery and is
 * called by the hook only after the notice body was actually emitted.
 */
const noticeSubCommand = defineCommand({
  meta: {
    name: "notice",
    description: "Emit pending tool update notices for the SessionStart hook",
  },
  args: {
    ack: {
      type: "string",
      description: "Comma-separated pluginId@x.y.z pairs to mark as delivered",
    },
  },
  run({ args }) {
    try {
      if (typeof args.ack === "string") {
        ackToolNotices(args.ack.split(",").filter(Boolean));
        return;
      }
      const config = readConfig(join(process.cwd(), "navori.config.json"));
      const updates = prepareToolNotices(config);
      if (updates.length === 0) return;
      const lang = resolveLang(config.language);
      const ack = updates.map((u) => `${u.pluginId}@${u.latestVersion}`).join(",");
      const lines = updates.map((u) =>
        toolNoticeText(lang, u.pluginId, u.installedVersion, u.latestVersion),
      );
      process.stdout.write(`${TOOL_NOTICE_SENTINEL}${ack}\n${lines.join("\n")}\n`);
    } catch {
      // Fail silent: a notice must never disturb session startup.
    }
  },
});

export const toolsCommand = defineCommand({
  meta: { name: "tools", description: "Machine commands about external tools" },
  subCommands: { notice: noticeSubCommand },
});
