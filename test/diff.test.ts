import { expect, test } from "bun:test";
import { diffLines } from "../src/diff.ts";

const show = (before: string | null, after: string, context?: number) =>
  diffLines(before, after, context).hunks.map((h) => h.map((l) => `${l.oldNo ?? ""}/${l.newNo ?? ""} ${l.kind}${l.text}`));

test("a line unchanged in the middle of an edit stays context", () => {
  const before = "function total(items, code) {\n  const sub = subtotal(items);\n  return sub - discount(sub, code);\n}\n";
  const after = "function total(items, code, tax = 0) {\n  const sub = subtotal(items);\n  const net = sub - discount(sub, code);\n  return net * (1 + tax);\n}\n";
  const d = diffLines(before, after);
  expect([d.added, d.removed]).toEqual([3, 2]);
  expect(show(before, after)).toEqual([[
    "1/ -function total(items, code) {",
    "/1 +function total(items, code, tax = 0) {",
    "2/2    const sub = subtotal(items);",
    "3/ -  return sub - discount(sub, code);",
    "/3 +  const net = sub - discount(sub, code);",
    "/4 +  return net * (1 + tax);",
    "4/5  }",
  ]]);
});

test("changes far apart become separate hunks with their own context", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const after = lines.map((l, i) => (i === 1 ? "A" : i === 17 ? "B" : l));
  const hunks = show(lines.join("\n") + "\n", after.join("\n") + "\n", 1);
  expect(hunks).toEqual([
    ["1/1  l1", "2/ -l2", "/2 +A", "3/3  l3"],
    ["17/17  l17", "18/ -l18", "/18 +B", "19/19  l19"],
  ]);
});

test("a new file is all additions, and a final newline is not an extra line", () => {
  const d = diffLines(null, "a\nb\n");
  expect([d.added, d.removed]).toEqual([2, 0]);
  expect(show(null, "a\nb\n")).toEqual([["/1 +a", "/2 +b"]]);
});

test("identical content has no hunks", () => {
  expect(diffLines("a\n", "a\n").hunks).toEqual([]);
});
