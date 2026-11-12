import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type ToolContext = {
  root: string; // real path of the workspace
  stateDir: string; // ~/.heyho/projects/<hash>, readable by the read tool
  seen: Map<string, string>; // abs path → mtime:size when last read or written by the agent
  // true allows; false or a string declines, the string being what the user said instead.
  approve: (kind: "edit" | "write" | "bash", summary: string, change?: Change) => Promise<boolean | string>;
  onChange?: (abs: string, before: string | null, after: string) => void; // a file was written
  onOutput?: (chunk: string) => void; // live output of a running command
  sandbox: { enabled: boolean; noNet: boolean };
  outCount: { n: number };
  signal?: AbortSignal;
};

// A file write about to happen or just done: `before` is null for a new file.
export type Change = { path: string; before: string | null; after: string };

export type ToolResult = { ok: boolean; text: string };

export type Tool = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, object>; required: string[] };
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

export const fail = (text: string): ToolResult => ({ ok: false, text });
export const ok = (text: string): ToolResult => ({ ok: true, text });

// Asks the user. Returns the result to hand back to the model when they decline.
export async function declined(ctx: ToolContext, kind: "edit" | "write" | "bash", summary: string, change?: Change): Promise<ToolResult | null> {
  const a = await ctx.approve(kind, summary, change);
  if (a === true) return null;
  if (typeof a === "string" && a.startsWith("Plan mode")) return fail(a);
  return fail(a ? `The user declined this action and said: ${a}` : "The user declined this action. Ask what they want instead, or try another approach.");
}

function inside(parent: string, child: string) {
  const r = relative(parent, child);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}

const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Resolves a path the model gave and refuses anything outside the workspace (after
// following symlinks). For a path that doesn't exist yet, the nearest existing parent
// is resolved instead. A symlink whose target is missing is refused: writing through it
// would create the target, wherever it points.
export function resolvePath(ctx: ToolContext, p: string, opts: { allowState?: boolean } = {}): string {
  const abs = resolve(ctx.root, p);
  let existing = abs;
  while (!lexists(existing)) existing = dirname(existing);
  if (!existsSync(existing)) throw new Error(`${p} is a symlink to a missing file. Use a path inside the working directory.`);
  const real = resolve(realpathSync(existing), relative(existing, abs));
  if (inside(ctx.root, real)) return real;
  if (opts.allowState && inside(realpathSync(ctx.stateDir), real)) return real;
  throw new Error(`${p} is outside the working directory ${ctx.root}. Use a path inside it.`);
}

export const stamp = (abs: string) => {
  const s = statSync(abs);
  return `${s.mtimeMs}:${s.size}`;
};

export const rel = (ctx: ToolContext, abs: string) => relative(ctx.root, abs) || ".";
