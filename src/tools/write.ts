import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkFresh } from "./edit.ts";
import { declined, fail, ok, rel, resolvePath, stamp, type Tool } from "./types.ts";

export const write: Tool = {
  name: "write",
  description: "Create a file, or replace a file's entire content. To change part of an existing file, use edit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to write" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, String(args.path));
    const shown = rel(ctx, abs);
    const content = String(args.content);
    const exists = existsSync(abs);
    if (exists) {
      const stale = checkFresh(ctx, abs, shown);
      if (stale) return fail(stale + " To change part of it, use edit.");
    }
    const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const preview = content.split("\n").slice(0, 20).join("\n");
    const no = await declined(ctx, "write", `${shown} (${exists ? "overwrite" : "new file"}, ${lines} lines)\n${preview}`);
    if (no) return no;
    const before = exists ? readFileSync(abs, "utf8") : null;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    ctx.onChange?.(abs, before, content);
    ctx.seen.set(abs, stamp(abs));
    return ok(`${exists ? "Overwrote" : "Created"} ${shown} (${lines} lines)`);
  },
};
