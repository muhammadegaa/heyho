// A tiny MCP server for the tests: JSON-RPC over stdio, one message per line, two tools.
// Started with "broken" as its argument it exits at once, to test a server that won't start.
import { createInterface } from "node:readline";

if (process.argv[2] === "broken") process.exit(3);

const tools = [
  { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "echo", description: "Return the text it was given.\nSecond line of the description.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return; // a notification
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "calc", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ id: m.id, result: { tools } });
  if (m.method === "tools/call") {
    const { name, arguments: args } = m.params;
    if (name === "add") {
      if (typeof args?.a !== "number" || typeof args?.b !== "number") return send({ id: m.id, result: { isError: true, content: [{ type: "text", text: "a and b must be numbers" }] } });
      return send({ id: m.id, result: { content: [{ type: "text", text: String(args.a + args.b) }] } });
    }
    if (name === "echo") return send({ id: m.id, result: { content: [{ type: "text", text: `echo: ${args.text}` }, { type: "image", data: "…" }] } });
    return send({ id: m.id, error: { code: -32601, message: `no tool ${name}` } });
  }
  send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
});
