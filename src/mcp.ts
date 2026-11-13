// A small MCP client: servers started as child processes, JSON-RPC over stdio with one
// message per line. Only tools are used. All of a session's MCP tools are reached through a
// single `mcp` tool, with their names and one-line descriptions listed in the system
// prompt, so a server with fifty tools does not put fifty schemas in every request.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Layer, Source } from "./settings.ts";
import { declined, fail, ok, type Tool } from "./tools/types.ts";

export type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };
export type McpTool = { name: string; description: string; inputSchema: object };

const START_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const RESULT_MAX_CHARS = 8000;
const LIST_MAX_CHARS = 1500;

export class McpServer {
  status: "running" | "failed" | "stopped" = "stopped";
  error = "";
  tools: McpTool[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly name: string;
  readonly source: Source;
  private config: ServerConfig;
  private cwd: string;

  constructor(name: string, config: ServerConfig, source: Source, cwd: string) {
    this.name = name;
    this.config = config;
    this.source = source;
    this.cwd = cwd;
  }

  private request(method: string, params: object, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.waiting.delete(id), reject(new Error(`no answer to ${method} within ${timeoutMs / 1000} s`))), timeoutMs);
      this.waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async start(): Promise<void> {
    try {
      const child = (this.child = spawn(this.config.command, this.config.args ?? [], { cwd: this.cwd, env: { ...process.env, ...this.config.env }, stdio: ["pipe", "pipe", "pipe"] }));
      let stderr = "";
      child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-500)));
      const gone = (why: string) => {
        if (this.status === "running") this.status = "stopped";
        for (const w of this.waiting.values()) w.reject(new Error(why));
        this.waiting.clear();
      };
      child.on("error", (e) => gone(e.message));
      child.on("exit", (code) => gone(`the server exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`));
      child.stdin.on("error", () => {});
      createInterface({ input: child.stdout }).on("line", (line) => {
        let m: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          m = JSON.parse(line);
        } catch {
          return; // a server that logs to stdout
        }
        const w = m.id === undefined ? undefined : this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id!);
        if (m.error) w.reject(new Error(m.error.message ?? "the server returned an error"));
        else w.resolve(m.result);
      });
      await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "heyho", version: "0" } }, START_TIMEOUT_MS);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = (await this.request("tools/list", {}, START_TIMEOUT_MS)) as { tools?: McpTool[] };
      this.tools = (listed.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } }));
      this.status = "running";
    } catch (e) {
      this.status = "failed";
      this.error = (e as Error).message;
      this.stop();
    }
  }

  async call(tool: string, args: object): Promise<{ text: string; isError: boolean }> {
    const r = (await this.request("tools/call", { name: tool, arguments: args }, CALL_TIMEOUT_MS)) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const items = r.content ?? [];
    const texts = items.filter((i) => i.type === "text").map((i) => i.text ?? "");
    const other = new Map<string, number>();
    for (const i of items) if (i.type !== "text") other.set(i.type, (other.get(i.type) ?? 0) + 1);
    for (const [type, n] of other) texts.push(`[${n} ${type} item${n > 1 ? "s" : ""} left out]`);
    const text = texts.join("\n");
    return { text: text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}\n[cut: ${text.length - RESULT_MAX_CHARS} more characters]` : text, isError: r.isError === true };
  }

  stop() {
    this.child?.kill();
    this.child = undefined;
    if (this.status === "running") this.status = "stopped";
  }
}

// Servers come from "mcpServers" in a settings file and from .mcp.json at the project
// root, which counts as part of the project.
export function serverConfigs(root: string, layers: Layer[]): [string, ServerConfig, Source][] {
  const out = new Map<string, [string, ServerConfig, Source]>();
  const take = (servers: unknown, source: Source) => {
    for (const [name, config] of Object.entries((servers ?? {}) as Record<string, ServerConfig>)) if (config && typeof config.command === "string") out.set(name, [name, config, source]);
  };
  for (const layer of layers) take((layer.settings as { mcpServers?: unknown }).mcpServers, layer.source);
  const file = join(root, ".mcp.json");
  if (existsSync(file)) {
    try {
      take(JSON.parse(readFileSync(file, "utf8")).mcpServers, "project");
    } catch {}
  }
  return [...out.values()];
}

const all = (servers: McpServer[]) => servers.filter((s) => s.status === "running").flatMap((s) => s.tools.map((t) => ({ server: s, tool: t, id: `${s.name}.${t.name}` })));

// The part of the system prompt that tells the model which MCP tools exist.
export function mcpPrompt(servers: McpServer[]): string {
  const tools = all(servers);
  if (!tools.length) return "";
  let text = 'MCP tools (call one with the mcp tool; "tool" is the name shown here):\n';
  for (const [n, t] of tools.entries()) {
    const line = `- ${t.id}: ${t.tool.description.split("\n")[0].slice(0, 100)}\n`;
    if (text.length + line.length > LIST_MAX_CHARS) return text + `- and ${tools.length - n} more; call mcp with a wrong name to see them all\n`;
    text += line;
  }
  return text;
}

export function mcpTool(servers: McpServer[]): Tool {
  return {
    name: "mcp",
    description: "Call a tool on an MCP server. The tools are listed in the system prompt.",
    parameters: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] },
    async run(args, ctx) {
      const tools = all(servers);
      const found = tools.find((t) => t.id === String(args.tool));
      if (!found) return fail(`No MCP tool "${args.tool}". Tools: ${tools.map((t) => t.id).join(", ")}`);
      const input = args.args && typeof args.args === "object" ? (args.args as object) : {};
      // The prompt lists tools by name only, so a model may call one bare to see what it takes.
      const schema = found.tool.inputSchema as { required?: string[] } | undefined;
      const missing = (schema?.required ?? []).filter((k) => !(k in input));
      if (missing.length) return fail(`${found.id} needs: ${missing.join(", ")}. Nothing was called.\nThe tool's input schema: ${JSON.stringify(schema)}`);
      const no = await declined(ctx, "mcp", `${found.id}\n${JSON.stringify(input, null, 1)}`);
      if (no) return no;
      try {
        const r = await found.server.call(found.tool.name, input);
        return r.isError ? fail(`${r.text}\nThe tool's input schema: ${JSON.stringify(found.tool.inputSchema)}`) : ok(r.text || "(no output)");
      } catch (e) {
        return fail(`${found.id} failed: ${(e as Error).message}`);
      }
    },
  };
}
