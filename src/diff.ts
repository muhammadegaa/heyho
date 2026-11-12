// Line diff for showing edits: numbered lines, a few lines of context, changes grouped into hunks.
export type DiffLine = { kind: " " | "+" | "-"; text: string; oldNo?: number; newNo?: number };
export type Diff = { hunks: DiffLine[][]; added: number; removed: number };

const LCS_MAX_CELLS = 4_000_000;

const toLines = (s: string) => {
  const lines = s.split("\n");
  if (lines.at(-1) === "") lines.pop(); // a final newline ends the last line, it doesn't start another
  return lines;
};

// The changed middle of two line arrays as a list of keep/remove/add steps.
function middle(a: string[], b: string[]): (" " | "+" | "-")[] {
  if (a.length * b.length > LCS_MAX_CELLS) return [...a.map(() => "-" as const), ...b.map(() => "+" as const)];
  const w = b.length + 1;
  const len = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) len[i * w + j] = a[i] === b[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
  const ops: (" " | "+" | "-")[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (ops.push(" "), i++, j++);
    else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) (ops.push("-"), i++);
    else (ops.push("+"), j++);
  }
  while (i++ < a.length) ops.push("-");
  while (j++ < b.length) ops.push("+");
  return ops;
}

export function diffLines(before: string | null, after: string, context = 3): Diff {
  const a = before === null ? [] : toLines(before);
  const b = toLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;

  const all: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  const keep = (text: string) => all.push({ kind: " ", text, oldNo: oldNo++, newNo: newNo++ });
  a.slice(0, start).forEach(keep);
  let i = start;
  let j = start;
  for (const op of middle(a.slice(start, a.length - end), b.slice(start, b.length - end))) {
    if (op === " ") (keep(a[i]), i++, j++);
    else if (op === "-") all.push({ kind: "-", text: a[i++], oldNo: oldNo++ });
    else all.push({ kind: "+", text: b[j++], newNo: newNo++ });
  }
  a.slice(a.length - end).forEach(keep);

  const hunks: DiffLine[][] = [];
  let last = -Infinity; // index of the last line already in a hunk
  all.forEach((line, at) => {
    if (line.kind === " ") return;
    const from = Math.max(0, at - context);
    if (from > last + 1) hunks.push([]);
    const hunk = hunks.at(-1)!;
    for (let k = Math.max(from, last + 1); k <= Math.min(all.length - 1, at + context); k++) {
      // Context after a change is added now and extended if another change follows closely.
      if (k > at && all[k].kind !== " ") break;
      hunk.push(all[k]);
      last = k;
    }
  });
  return { hunks, added: all.filter((l) => l.kind === "+").length, removed: all.filter((l) => l.kind === "-").length };
}
