// Shows what this terminal sends for the keys heyho cares about, with the kitty keyboard
// protocol off and then on. Run it in the terminal you use: bun scripts/keys.ts
import { stdin, stdout } from "node:process";

const shown = (b: Buffer) => [...b.toString("latin1")].map((c) => (c === "\x1b" ? "ESC" : c === "\r" ? "CR" : c === "\n" ? "LF" : c.charCodeAt(0) < 32 ? `^${String.fromCharCode(c.charCodeAt(0) + 64)}` : c)).join(" ");
const read = (ms: number) =>
  new Promise<Buffer | null>((done) => {
    const t = setTimeout(() => (stdin.off("data", on), done(null)), ms);
    const on = (b: Buffer) => (clearTimeout(t), stdin.off("data", on), done(b));
    stdin.on("data", on);
  });

const KEYS = ["Enter", "Shift+Enter", "Option+Enter", "Ctrl+J", "Option+Left", "Esc"];

async function round(label: string) {
  stdout.write(`\n${label}\n`);
  const got: string[] = [];
  for (const k of KEYS) {
    stdout.write(`  press ${k} ... `);
    const b = await read(30_000);
    const s = b ? shown(b) : "(nothing in 30 s)";
    got.push(s);
    stdout.write(`${s}\n`);
    if (b?.[0] === 3) process.exit(1);
  }
  return got;
}

stdin.setRawMode(true);
stdin.resume();
stdout.write("\x1b[?u");
const answer = await read(300);
const kitty = answer ? /\x1b\[\?\d+u/.test(answer.toString("latin1")) : false;
stdout.write(`kitty keyboard protocol: ${kitty ? "supported" : "no answer, not supported"}\n`);
const plain = await round("Protocol off (how heyho saw keys before this change):");
let withKitty: string[] = [];
if (kitty) {
  stdout.write("\x1b[>1u");
  withKitty = await round("Protocol on (how heyho sees keys now):");
  stdout.write("\x1b[<u");
}
stdin.setRawMode(false);
stdout.write(`\nCopy from here:\nkitty=${kitty}\n${KEYS.map((k, i) => `${k}: off=[${plain[i]}]${kitty ? ` on=[${withKitty[i]}]` : ""}`).join("\n")}\n`);
process.exit(0);
