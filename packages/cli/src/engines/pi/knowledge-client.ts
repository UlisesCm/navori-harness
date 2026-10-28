import type { ChildProcess, SpawnOptions } from "node:child_process";

/** One MCP server a Pi child may reach, fixed at render time (never built from model text). */
export interface KnowledgeServerSpec {
  readonly command: string;
  /** Fixed argv; the literal token `{cwd}` is replaced by the child's working directory. */
  readonly args: readonly string[];
  /** Extra env set on top of the filtered parent env. */
  readonly env: Readonly<Record<string, string>>;
  /** The closed allowlist of MCP tool names this client will ever send to the server. */
  readonly tools: readonly string[];
  /** Per `tools/call` deadline. */
  readonly timeoutMs: number;
  /** Deadline of the initialize handshake (default 20 s). */
  readonly initTimeoutMs?: number;
}

/** Outcome of a call: always a value, never a throw, so a missing binary or index is a tool error. */
export interface KnowledgeResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface KnowledgeClient {
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult>;
  /** Kill every server this client started and fail whatever was still waiting on them. */
  shutdown(): void;
}

export type KnowledgeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Minimal newline-delimited JSON-RPC (MCP stdio) client used by Pi children to reach the codegraph
 * and engram servers read-only. SERIALIZED into the Pi extension (`serializeAnonymousFunction`), so
 * it must stay self-contained: no outer identifier, no helper, no import may be referenced; the
 * only free names are runtime globals (`Buffer`, `setTimeout`, `clearTimeout`, `JSON`, `Map`,
 * `Promise`) and the injected `spawn`. Lazy: a server starts on its first call, one process per
 * (server, cwd) even under concurrent first calls (the init promise is shared), and at most two
 * starts per key (one respawn). The `tools` allowlist of the spec is the control that matters: a
 * name outside it never leaves this process. Expected failures (missing binary, no index, timeout,
 * crash) resolve as `isError` results, never as rejections.
 */
export function createKnowledgeClient(
  spawn: KnowledgeSpawn,
  servers: Readonly<Record<string, KnowledgeServerSpec>>,
  parentEnv: Readonly<Record<string, string | undefined>>,
  maxBytes: number,
): KnowledgeClient {
  type Pending = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
  };
  type Entry = {
    proc: ChildProcess;
    pending: Map<number, Pending>;
    ready: Promise<void>;
    nextId: number;
    dead: boolean;
    stderrTail: string;
  };
  const entries = new Map<string, Entry>();
  const starts = new Map<string, number>();
  const MAX_STARTS = 2;
  const MAX_LINE_BYTES = 8 * 1024 * 1024;
  const INIT_TIMEOUT_MS = 20_000;
  const ENV_KEEP =
    /^(?:PATH|HOME|USERPROFILE|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|SHELL|SYSTEMROOT|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|XDG_[A-Z_]+|CODEGRAPH_[A-Z_]+|ENGRAM_[A-Z_]+)$/i;

  /** Pipes are sockets with `unref`; anything else (a test double) is left alone. */
  const unref = (stream: unknown): void => {
    if (
      typeof stream === "object" &&
      stream !== null &&
      "unref" in stream &&
      typeof stream.unref === "function"
    ) {
      stream.unref();
    }
  };

  const filteredEnv = (extra: Readonly<Record<string, string>>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const key of Object.keys(parentEnv)) {
      const value = parentEnv[key];
      if (value !== undefined && ENV_KEEP.test(key)) out[key] = value;
    }
    return { ...out, ...extra };
  };

  /** Cut by BYTES, never inside a UTF-8 sequence, and say so. */
  const bound = (text: string): string => {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maxBytes) return text;
    let end = maxBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return (
      bytes.subarray(0, end).toString("utf8") + "\n[output truncated at " + maxBytes + " bytes]"
    );
  };

  const fail = (entry: Entry, reason: string): void => {
    if (entry.dead) return;
    entry.dead = true;
    const tail = entry.stderrTail.trim();
    const error = new Error(reason + (tail ? "\nserver stderr (tail): " + tail : ""));
    for (const waiting of [...entry.pending.values()]) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    entry.pending.clear();
    try {
      entry.proc.stdin?.end();
    } catch {
      /* Already closed. */
    }
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      /* Already gone. */
    }
  };

  const send = (entry: Entry, message: Record<string, unknown>): void => {
    if (entry.dead || !entry.proc.stdin || entry.proc.stdin.destroyed) return;
    try {
      entry.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    } catch {
      /* Surfaces as exit. */
    }
  };

  const request = (
    entry: Entry,
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      if (entry.dead) {
        reject(new Error("server is not running"));
        return;
      }
      if (signal?.aborted) {
        reject(new Error("call aborted"));
        return;
      }
      const id = entry.nextId++;
      const settle = (): void => {
        const waiting = entry.pending.get(id);
        if (waiting?.timer) clearTimeout(waiting.timer);
        entry.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (reason: string): void => {
        settle();
        send(entry, { method: "notifications/cancelled", params: { requestId: id, reason } });
      };
      const timer = setTimeout((): void => {
        cancel("timeout");
        reject(new Error("timed out after " + Math.round(timeoutMs / 1000) + " s"));
      }, timeoutMs);
      function onAbort(): void {
        cancel("aborted");
        reject(new Error("call aborted"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.pending.set(id, {
        resolve: (value): void => {
          settle();
          resolve(value);
        },
        reject: (error): void => {
          settle();
          reject(error);
        },
        timer,
      });
      send(entry, { id, method, params });
    });

  const onLine = (entry: Entry, line: string): void => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return; /* Not JSON-RPC (banner or log noise): ignored. */
    }
    if (typeof message.method === "string") {
      // A server request (roots/list, sampling, ...) needs an answer or it may wait forever; a
      // notification (no id) needs none. Navori offers no capability, so everything but ping is refused.
      if (message.id === undefined || message.id === null) return;
      if (message.method === "ping") send(entry, { id: message.id, result: {} });
      else send(entry, { id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = entry.pending.get(message.id);
    if (!waiting) return;
    const error = message.error;
    if (typeof error === "object" && error !== null) {
      const text = (error as Record<string, unknown>).message;
      waiting.reject(new Error("server error: " + (typeof text === "string" ? text : "unknown")));
    } else waiting.resolve(message.result);
  };

  const start = (key: string, spec: KnowledgeServerSpec, cwd: string): Entry => {
    starts.set(key, (starts.get(key) ?? 0) + 1);
    const argv = spec.args.map((arg) => (arg === "{cwd}" ? cwd : arg));
    const proc = spawn(spec.command, argv, {
      cwd,
      env: filteredEnv(spec.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const entry: Entry = {
      proc,
      pending: new Map(),
      ready: Promise.resolve(),
      nextId: 1,
      dead: false,
      stderrTail: "",
    };
    entries.set(key, entry);
    // Never hold Pi's event loop open: shutdown kills the server, and stdin EOF stops it if we are killed first.
    proc.unref();
    for (const stream of [proc.stdout, proc.stderr, proc.stdin]) unref(stream);
    let buffered = Buffer.alloc(0);
    proc.stdout?.on("data", (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let cut = buffered.indexOf(10); cut !== -1; cut = buffered.indexOf(10)) {
        const line = buffered.subarray(0, cut).toString("utf8").trim();
        buffered = buffered.subarray(cut + 1);
        if (line) onLine(entry, line);
      }
      if (buffered.length > MAX_LINE_BYTES) fail(entry, "server sent an oversized message");
    });
    // Drained so the server never blocks on a full pipe; only a short tail is kept for failure text.
    proc.stderr?.on("data", (chunk: Buffer): void => {
      entry.stderrTail = (entry.stderrTail + chunk.toString("utf8")).slice(-1024);
    });
    proc.stdin?.on("error", (): void => {
      /* EPIPE after exit is reported by the exit handler. */
    });
    proc.on("error", (error: Error & { code?: string }): void => {
      fail(
        entry,
        error.code === "ENOENT"
          ? spec.command + " is not on PATH"
          : spec.command + " could not start",
      );
    });
    proc.on("close", (code: number | null): void => {
      fail(entry, spec.command + " exited (code " + String(code) + ")");
    });
    entry.ready = request(
      entry,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "navori-pi-child", version: "1" },
      },
      spec.initTimeoutMs ?? INIT_TIMEOUT_MS,
    ).then((): void => {
      send(entry, { method: "notifications/initialized" });
    });
    // A failed handshake (timeout or error) kills the server and frees the slot, so a later call can
    // respawn within the start limit; callers awaiting `ready` still see the original rejection.
    entry.ready.catch((cause: unknown): void => {
      fail(entry, cause instanceof Error ? cause.message : "initialize failed");
    });
    return entry;
  };

  return {
    async call(server, tool, args, cwd, signal): Promise<KnowledgeResult> {
      const spec = Object.prototype.hasOwnProperty.call(servers, server)
        ? servers[server]
        : undefined;
      if (!spec || !spec.tools.includes(tool)) {
        return {
          text:
            "Navori refuses " +
            server +
            "/" +
            tool +
            ": it is not a read-only tool granted to Pi children.",
          isError: true,
        };
      }
      const key = server + "\u0000" + cwd;
      try {
        let entry = entries.get(key);
        if (!entry || entry.dead) {
          if ((starts.get(key) ?? 0) >= MAX_STARTS) {
            return {
              text:
                spec.command + " failed repeatedly in this child; continue with read/grep/find.",
              isError: true,
            };
          }
          entry = start(key, spec, cwd);
        }
        await entry.ready;
        const result = await request(
          entry,
          "tools/call",
          { name: tool, arguments: args },
          spec.timeoutMs,
          signal,
        );
        const record =
          typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        const content = Array.isArray(record.content) ? (record.content as unknown[]) : [];
        const text = content
          .map((part) => {
            const item =
              typeof part === "object" && part !== null ? (part as Record<string, unknown>) : {};
            return item.type === "text" && typeof item.text === "string" ? item.text : "";
          })
          .filter((part) => part !== "")
          .join("\n");
        return { text: bound(text || "(no output)"), isError: record.isError === true };
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : "unknown failure";
        return {
          text: bound(
            spec.command + " is unavailable: " + reason + ". Continue with read/grep/find.",
          ),
          isError: true,
        };
      }
    },
    shutdown(): void {
      for (const entry of [...entries.values()]) fail(entry, "shut down");
      entries.clear();
    },
  };
}
