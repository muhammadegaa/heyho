import { readdirSync, readFileSync, statSync } from "node:fs";
import { fail, ok, rel, resolvePath, stamp, type Tool } from "./types.ts";

const DEFAULT_LINES = 250;
const MAX_BYTES = 12_000;
const MAX_LINE = 500;

export const read: Tool = {
  name: "read",
  description:
    "Read a file, or list a directory. File lines come back as `N: text`; the `N: ` prefix is not part of the file. Returns up to 250 lines; the footer gives the offset to continue.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path" },
      offset: { type: "integer", description: "First line to read, 1-based" },
      limit: { type: "integer", description: "Number of lines to read" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, String(args.path), { allowState: true });
    let st;
    try {
      st = statSync(abs);
    } catch {
      return fail(`${args.path} does not exist. Use search with a glob to find the right path.`);
    }
    if (st.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== ".git")
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort();
      const shown = entries.slice(0, 200);
      return ok(shown.join("\n") + (entries.length > 200 ? `\n[${entries.length - 200} more entries]` : "") || "(empty directory)");
    }
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return fail(`${args.path} is a binary file (${buf.length} bytes).`);
    const lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const total = lines.length;
    const start = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || DEFAULT_LINES);
    if (start > total && total > 0) return fail(`offset ${start} is past the end of the file (${total} lines).`);

    let out = "";
    let end = start - 1;
    for (let i = start - 1; i < Math.min(total, start - 1 + limit); i++) {
      const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) + " [line truncated]" : lines[i];
      const next = `${i + 1}: ${line}\n`;
      if (out.length + next.length > MAX_BYTES && end >= start) break;
      out += next;
      end = i + 1;
    }
    ctx.seen.set(abs, stamp(abs));
    const footer =
      total === 0 ? "[empty file]" : end < total ? `[lines ${start}-${end} of ${total}; continue with offset=${end + 1}]` : `[end of file, ${total} lines]`;
    return ok(`${rel(ctx, abs)}\n${out}${footer}`);
  },
};
