import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fail, ok, rel, resolvePath, type Tool } from "./types.ts";

const MAX_MATCHES = 50;
const MAX_LINE = 200;

const onPath = (bin: string) => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
const inGit = (cwd: string) => spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" }).stdout.trim() === "true";

// ripgrep if installed, else git grep (respects .gitignore), else grep -r.
function command(root: string, pattern: string | undefined, glob: string | undefined, path: string): [string, string[]] {
  const deepGlob = glob && !glob.includes("/") ? `**/${glob}` : glob;
  if (onPath("rg")) {
    const g = glob ? ["-g", glob] : [];
    return pattern
      ? ["rg", ["-n", "--no-heading", "--color", "never", ...g, "-e", pattern, "--", path]]
      : ["rg", ["--files", ...g, "--", path]];
  }
  if (inGit(root)) {
    // Separate pathspecs are OR'd, so path and glob must be one spec.
    const spec = [deepGlob ? `:(glob)${path === "." ? "" : path + "/"}${deepGlob}` : path];
    return pattern
      ? ["git", ["grep", "-n", "-I", "-P", "--untracked", "-e", pattern, "--", ...spec]]
      : ["git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...spec]];
  }
  return pattern
    ? ["grep", ["-rnIE", "--exclude-dir=.git", "--exclude-dir=node_modules", ...(glob ? [`--include=${glob}`] : []), "-e", pattern, path]]
    : ["find", [path, "-type", "f", "-not", "-path", "*/.git/*", "-not", "-path", "*/node_modules/*", ...(glob ? ["-name", glob] : [])]];
}

export const search: Tool = {
  name: "search",
  description:
    "Search file contents with a regular expression, or list files matching a glob when pattern is omitted. Skips .gitignored files. Returns up to 50 results as `path:line: text`.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex to search for" },
      glob: { type: "string", description: "Only files matching this glob, e.g. *.ts or src/**/*.py" },
      path: { type: "string", description: "Directory or file to search (default: working directory)" },
    },
    required: [],
  },
  async run(args, ctx) {
    const pattern = args.pattern ? String(args.pattern) : undefined;
    const glob = args.glob ? String(args.glob) : undefined;
    if (!pattern && !glob) return fail("Give a pattern to search for, a glob to list files, or both.");
    const path = rel(ctx, resolvePath(ctx, args.path ? String(args.path) : "."));
    const [bin, argv] = command(ctx.root, pattern, glob, path);
    const r = spawnSync(bin, argv, { cwd: ctx.root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    if (r.status !== 0 && r.status !== 1) return fail(`search failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 500)}`);
    const lines = r.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, ""));
    const files = pattern ? lines : lines.filter((l) => existsSync(join(ctx.root, l)));
    if (!files.length) return ok("No matches.");
    const shown = files.slice(0, MAX_MATCHES).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + " [cut]" : l));
    const more = files.length > MAX_MATCHES ? `\n[showing ${MAX_MATCHES} of ${files.length}; narrow the pattern, glob or path]` : "";
    return ok(shown.join("\n") + more);
  },
};
