import { defineCommand } from "citty";
import { join } from "node:path";
import { readConfig } from "../lib/config/config.ts";
import { resolveLang, toolNoticeText } from "../lib/i18n.ts";
import { ackToolNotices, prepareToolNotices } from "../lib/primitives/tool-version-notice.ts";
import { rustShadowCommand } from "../lib/rust-shadow/command.ts";
import { dominioInjectText } from "../lib/workspace/dominio-inject.ts";

/**
 * Output contract v1, read by the SessionStart hook: the FIRST line is exactly
 * `#navori-tool-notice v1 ack=<pluginId>@<x.y.z>[,...]`, followed by one localized line per
 * tool. With nothing to say the command prints nothing at all. The hook discards any output
 * that does not start with this sentinel, which is what keeps an older navori (whose usage
 * banner would land on stdout for an unknown subcommand) out of the model's context.
 */
export const TOOL_NOTICE_SENTINEL = "#navori-tool-notice v1 ack=";

/**
 * What `tools notice` prints: the sentinel line plus one localized line per pending
 * tool, or `""` with nothing to say. Throws when the config cannot be read.
 */
export function toolNoticeOutput(): string {
  const config = readConfig(join(process.cwd(), "navori.config.json"));
  const updates = prepareToolNotices(config);
  if (updates.length === 0) return "";
  const lang = resolveLang(config.language);
  const ack = updates.map((u) => `${u.pluginId}@${u.latestVersion}`).join(",");
  const lines = updates.map((u) =>
    toolNoticeText(lang, u.pluginId, u.installedVersion, u.latestVersion),
  );
  return `${TOOL_NOTICE_SENTINEL}${ack}\n${lines.join("\n")}\n`;
}

/** Output contract v1 of `tools session-context`, read by the SessionStart hook. */
export const SESSION_CONTEXT_BEGIN = "#navori-session-context v1";
export const SESSION_CONTEXT_NOTICE = "#section notice";
export const SESSION_CONTEXT_DOMINIO = "#section dominio";
export const SESSION_CONTEXT_END = "#end navori-session-context";

/**
 * The whole `session-context` output, or `null` when it must not be printed: either
 * section failed to compute, or a section's text could contain one of the sentinel
 * markers (it would let content spoof the framing the hook parses).
 * An explicit UTF-8 reservation adds `notice-reserve` to the first line and acknowledges
 * fitting notice bodies only after both sections validate; the default v1 output stays unchanged.
 */
export function sessionContextOutput(
  notice: () => string,
  dominio: () => string,
  noticeReserve?: number,
): string | null {
  try {
    const sections = [
      process.env.NAVORI_NO_UPDATE_NOTIFIER === "1" ? "" : notice(),
      dominio(),
    ] as const;
    if (sections.some((text) => text.includes("#section ") || text.includes("#end navori-")))
      return null;
    if (noticeReserve !== undefined && (!Number.isSafeInteger(noticeReserve) || noticeReserve < 0))
      return null;
    const out = [
      `${SESSION_CONTEXT_BEGIN}${noticeReserve === undefined ? "" : " notice-reserve"}\n${SESSION_CONTEXT_NOTICE}\n${sections[0]}`,
      `${SESSION_CONTEXT_DOMINIO}\n${sections[1]}${SESSION_CONTEXT_END}\n`,
    ].join("");
    if (noticeReserve !== undefined && sections[0] !== "") {
      const match = /^#navori-tool-notice v1 ack=([A-Za-z0-9._@,-]+)\n([\s\S]+)\n$/.exec(
        sections[0],
      );
      if (!match || !match[1] || !match[2]) return null;
      // Match the hook: remove the frame's final LF, then reserve the body's emission LF.
      if (Buffer.byteLength(match[2], "utf8") + 1 <= noticeReserve)
        ackToolNotices(match[1].split(",").filter(Boolean));
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * `session-context` is a MACHINE command for the SessionStart hook (spec 0054 R25): the
 * output of `tools notice` and `dominio inject` in ONE process, as two sentinel-framed
 * sections. All or nothing: if either section fails, nothing is printed and the exit code
 * is 1, so the hook falls back to the two separate calls. With `--notice-reserve`, delivery
 * is acknowledged here before emission; an interrupted hook can still find it in doctor.
 */
const sessionContextSubCommand = defineCommand({
  meta: {
    name: "session-context",
    description: "Emit the notice and Dominio sections for the SessionStart hook in one call",
  },
  args: {
    "notice-reserve": { type: "string", description: "UTF-8 bytes reserved for notice delivery" },
  },
  run({ args }) {
    const reserve = args["notice-reserve"];
    const out = sessionContextOutput(
      toolNoticeOutput,
      dominioInjectText,
      reserve === undefined ? undefined : /^\d+$/.test(reserve) ? Number(reserve) : NaN,
    );
    if (out === null) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(out);
  },
});

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
      process.stdout.write(toolNoticeOutput());
    } catch {
      // Fail silent: a notice must never disturb session startup.
    }
  },
});

export const toolsCommand = defineCommand({
  meta: { name: "tools", description: "Machine commands about external tools" },
  subCommands: {
    notice: noticeSubCommand,
    "session-context": sessionContextSubCommand,
    "rust-shadow": rustShadowCommand,
  },
});
