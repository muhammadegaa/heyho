import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DENIED, fail, ok, rel, resolvePath, stamp, type Tool, type ToolContext } from "./types.ts";

// Typographic characters models often substitute. Each maps to exactly one character,
// so indices in the normalized text are valid in the original.
const UNI: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "　": " ",
};
const norm = (s: string) => s.replace(/[‘-‟‐-―−     　]/g, (c) => UNI[c] ?? c);

type Range = [number, number];

function indicesOf(hay: string, needle: string): Range[] {
  const out: Range[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}

// Matches whole lines, ignoring trailing whitespace on each line.
function lineMatches(text: string, old: string): Range[] {
  const tl = text.split("\n");
  const ol = old.replace(/\n$/, "").split("\n").map((l) => norm(l).trimEnd());
  const key = tl.map((l) => norm(l).trimEnd());
  const starts: number[] = [];
  let pos = 0;
  for (const l of tl) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const out: Range[] = [];
  for (let i = 0; i + ol.length <= tl.length; i++) {
    if (ol.every((l, j) => key[i + j] === l)) {
      const last = i + ol.length - 1;
      out.push([starts[i], starts[last] + tl[last].length]);
      i = last;
    }
  }
  return out;
}

export function locate(text: string, old: string): { ranges: Range[]; tier: string } {
  let ranges = indicesOf(text, old);
  if (ranges.length) return { ranges, tier: "" };
  ranges = indicesOf(norm(text), norm(old));
  if (ranges.length) return { ranges, tier: "matched after normalizing quotes, dashes and spaces" };
  ranges = lineMatches(text, old);
  return { ranges, tier: ranges.length ? "matched ignoring trailing whitespace" : "" };
}

function closestLines(text: string, old: string): string {
  const lines = text.split("\n");
  const votes = new Map<number, number>();
  old.split("\n").forEach((o, j) => {
    const t = norm(o).trim();
    if (t.length < 3) return;
    lines.forEach((l, i) => {
      if (norm(l).trim() === t) votes.set(i - j, (votes.get(i - j) ?? 0) + 1);
    });
  });
  if (!votes.size) return "No similar lines found. Read the file again to see its current content.";
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const from = Math.max(0, best);
  const to = Math.min(lines.length, from + Math.min(12, Math.max(old.split("\n").length, 3)));
  return "The closest lines in the file:\n" + lines.slice(from, to).map((l, k) => `${from + k + 1}: ${l}`).join("\n");
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

function summarize(oldText: string, newText: string, line: number): string {
  const body = [...oldText.split("\n").map((l) => "- " + l), ...newText.split("\n").map((l) => "+ " + l)];
  return `@@ line ${line}\n` + (body.length > 40 ? body.slice(0, 40).join("\n") + `\n[${body.length - 40} more diff lines]` : body.join("\n"));
}

export function checkFresh(ctx: ToolContext, abs: string, shown: string): string | null {
  const seen = ctx.seen.get(abs);
  if (!seen) return `Read ${shown} before changing it.`;
  if (seen !== stamp(abs)) return `${shown} changed on disk since you last read it. Read it again first.`;
  return null;
}

export const edit: Tool = {
  name: "edit",
  description:
    "Replace exact text in a file. old_string must match the file exactly, including indentation, without the `N: ` line prefixes from read, and must be unique unless replace_all is true. Read the file first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, String(args.path));
    const shown = rel(ctx, abs);
    if (!existsSync(abs)) return fail(`${shown} does not exist. Use write to create it.`);
    const stale = checkFresh(ctx, abs, shown);
    if (stale) return fail(stale);
    const old = String(args.old_string).replace(/\r\n/g, "\n");
    const neu = String(args.new_string).replace(/\r\n/g, "\n");
    if (!old) return fail("old_string is empty. To create or overwrite a whole file, use write.");
    if (old === neu) return fail("old_string and new_string are identical; nothing to change.");

    const raw = readFileSync(abs, "utf8");
    const crlf = raw.includes("\r\n");
    const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
    const { ranges, tier } = locate(text, old);
    if (!ranges.length) {
      const hint = text.includes(neu) ? "new_string is already in the file, so this edit may already be applied." : closestLines(text, old);
      return fail(`Could not find old_string in ${shown}. It must match exactly, including whitespace and indentation.\n${hint}`);
    }
    if (ranges.length > 1 && args.replace_all !== true) {
      const at = ranges.map(([s]) => lineOf(text, s)).join(", ");
      return fail(`Found ${ranges.length} matches for old_string in ${shown} (lines ${at}). Add surrounding lines to make it unique, or set replace_all to true.`);
    }
    // The line-based tier matched without the final newline, so drop it from the replacement too.
    const replacement = tier.includes("trailing") && old.endsWith("\n") && neu.endsWith("\n") ? neu.slice(0, -1) : neu;
    let out = text;
    for (const [s, e] of [...ranges].reverse()) out = out.slice(0, s) + replacement + out.slice(e);

    const [s0, e0] = ranges[0];
    const diff = summarize(text.slice(s0, e0), replacement, lineOf(text, s0));
    if (!(await ctx.approve("edit", `${shown}\n${diff}`))) return DENIED;
    writeFileSync(abs, crlf ? out.replace(/\n/g, "\r\n") : out);
    ctx.seen.set(abs, stamp(abs));
    const note = [ranges.length > 1 ? `${ranges.length} replacements` : "", tier].filter(Boolean).join(", ");
    return ok(`Edited ${shown}${note ? ` (${note})` : ""}\n${diff}`);
  },
};
