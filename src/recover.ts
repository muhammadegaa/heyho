import { jsonrepair } from "jsonrepair";
import type { Tool } from "./tools/types.ts";

// Names local models use for our tools, learned from other harnesses' schemas.
const NAME_ALIASES: Record<string, string> = {
  shell: "bash", run: "bash", run_command: "bash", execute: "bash", execute_command: "bash", terminal: "bash",
  read_file: "read", view: "read", cat: "read", open_file: "read",
  edit_file: "edit", str_replace: "edit", replace: "edit", replace_in_file: "edit",
  write_file: "write", create_file: "write", create: "write",
  grep: "search", rg: "search", glob: "search", find: "search", search_files: "search", find_files: "search",
};

const KEY_ALIASES: Record<string, string[]> = {
  path: ["file_path", "filePath", "file", "filename", "file_name", "dir", "directory"],
  old_string: ["old", "oldString", "old_str", "old_text", "oldText", "search"],
  new_string: ["new", "newString", "new_str", "new_text", "newText", "replacement"],
  replace_all: ["replaceAll"],
  content: ["contents", "text", "file_text", "data"],
  command: ["cmd", "script"],
  pattern: ["query", "regex"],
  offset: ["start_line", "line"],
  limit: ["max_lines", "lines"],
};

export function toolName(name: string): string {
  const n = name.trim();
  return NAME_ALIASES[n] ?? NAME_ALIASES[n.toLowerCase()] ?? n;
}

// Returns parsed arguments, or an error string. Repaired JSON is accepted; JSON that
// can't be repaired is never executed.
export function parseArgs(raw: string): { args: Record<string, unknown>; repaired: boolean } | string {
  if (!raw.trim()) return { args: {}, repaired: false };
  let value: unknown;
  let repaired = false;
  try {
    value = JSON.parse(raw);
  } catch {
    try {
      value = JSON.parse(jsonrepair(raw));
      repaired = true;
    } catch {
      return `The tool arguments are not valid JSON, so the call was not executed. Reissue the call with valid JSON arguments. Received: ${raw.slice(0, 200)}`;
    }
  }
  if (typeof value === "string") return parseArgs(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return `Tool arguments must be a JSON object. Received: ${raw.slice(0, 200)}`;
  return { args: value as Record<string, unknown>, repaired };
}

// Maps aliased keys onto the schema's names, converts stringified scalars, checks required keys.
export function normalizeArgs(tool: Tool, input: Record<string, unknown>): Record<string, unknown> | string {
  const args: Record<string, unknown> = {};
  const props = tool.parameters.properties as Record<string, { type: string }>;
  for (const [key, schema] of Object.entries(props)) {
    let v = input[key];
    if (v === undefined) {
      const alias = KEY_ALIASES[key]?.find((a) => input[a] !== undefined && !(a in props));
      if (alias) v = input[alias];
    }
    if (v === undefined || v === null) continue;
    if (schema.type === "integer" && typeof v === "string" && /^\d+$/.test(v.trim())) v = Number(v);
    if (schema.type === "boolean" && typeof v === "string") v = v.trim().toLowerCase() === "true";
    if (schema.type === "string" && (typeof v === "number" || typeof v === "boolean")) v = String(v);
    args[key] = v;
  }
  const missing = tool.parameters.required.filter((k) => args[k] === undefined);
  if (missing.length) {
    const expected = Object.keys(props).map((k) => (tool.parameters.required.includes(k) ? k : k + "?")).join(", ");
    return `Missing required argument ${missing.map((m) => `"${m}"`).join(", ")} for ${tool.name}. Arguments: ${expected}.`;
  }
  return args;
}

// Tool calls written into the message text instead of the tool_calls field. Counted in M1;
// parsed and executed from M2.
export const looksLikeTextToolCall = (content: string | null) =>
  !!content && /<tool_call>|<function=\w+|"name"\s*:\s*"(read|edit|write|bash|search)"/.test(content);

// Counts consecutive identical calls (name + arguments). Re-running the same test command
// between edits is normal, so only an unbroken run of the same call counts.
export class LoopGuard {
  private last = "";
  private n = 0;
  see(name: string, args: Record<string, unknown>): number {
    const key = name + JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
    this.n = key === this.last ? this.n + 1 : 1;
    this.last = key;
    return this.n;
  }
}
