import { createInterface } from "node:readline";

/**
 * search-v2 §8.4 — MCP stdio transport for the runtime test suite only.
 *
 * This is NOT a general-purpose MCP client and must never ship as a product
 * feature: it implements exactly what the test protocol needs — JSON-RPC 2.0
 * over newline-delimited stdio, `initialize`/`tools/list`/`tools/call`, and
 * auto-answering server-initiated `roots/list`/`ping` requests — nothing
 * more (§8.4: "no lo publiques como producto").
 */
export class McpTestClient {
  #child;
  #rl;
  #nextId = 0;
  #pending = new Map();
  #stderrChunks = [];
  #roots;

  /**
   * @param {import('node:child_process').ChildProcessWithoutNullStreams} child
   * @param {{ roots?: Array<{ uri: string, name?: string }> }} [options]
   */
  constructor(child, options = {}) {
    this.#child = child;
    this.#roots = options.roots ?? [];
    this.#rl = createInterface({ input: child.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));
    child.stderr.on("data", (chunk) => this.#stderrChunks.push(chunk.toString("utf8")));
  }

  /** Accumulated stderr text captured so far, for diagnostics. */
  get stderr() {
    return this.#stderrChunks.join("");
  }

  #send(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Non-JSON noise on stdout is not part of the protocol; ignore it.
      return;
    }

    if (message.method === "roots/list") {
      this.#send({ jsonrpc: "2.0", id: message.id, result: { roots: this.#roots } });
      return;
    }
    if (message.method === "ping") {
      this.#send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const { resolve, timer } = this.#pending.get(message.id);
      clearTimeout(timer);
      this.#pending.delete(message.id);
      resolve(message);
    }
  }

  /**
   * Sends a JSON-RPC request and resolves with the raw response envelope
   * (caller inspects `.result` / `.error`). Rejects on timeout — a deadline
   * that expires is a failure, never a silent success.
   */
  request(method, params, timeoutMs = 30_000) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Negotiates the MCP session. Accepts any `protocolVersion` the server
   * returns that is present in `supportedVersions` — the codegraph 1.6.0
   * binary observed in practice negotiates down to `2024-11-05` even when
   * `2025-03-26` is proposed, which is a valid negotiation outcome per the
   * MCP spec, not a protocol failure.
   */
  async initialize({
    protocolVersion = "2025-03-26",
    supportedVersions = [protocolVersion, "2024-11-05"],
    timeoutMs = 30_000,
  } = {}) {
    const response = await this.request(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "navori-search-v2-runtime-test", version: "0.0.1" },
      },
      timeoutMs,
    );
    if (response.error) {
      throw new Error(`initialize failed: ${JSON.stringify(response.error)}`);
    }
    const negotiated = response.result?.protocolVersion;
    if (!supportedVersions.includes(negotiated)) {
      throw new Error(
        `unsupported protocolVersion negotiated: ${negotiated} (supported: ${supportedVersions.join(", ")})`,
      );
    }
    this.notify("notifications/initialized", {});
    return response.result;
  }

  async listTools(timeoutMs = 30_000) {
    const response = await this.request("tools/list", {}, timeoutMs);
    if (response.error) {
      throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  /** Returns the raw response envelope; callers check `.result.isError`. */
  callTool(name, args, timeoutMs = 30_000) {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  close() {
    this.#rl.close();
  }
}
