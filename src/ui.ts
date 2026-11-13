// What the user sees. No dependencies: ANSI codes on stderr for everything except the
// model's own text, which goes to stdout so `heyho "task" > file` captures only the answer.
// Without a terminal on stderr the output is the plain line format the eval logs use.
import { diffLines } from "./diff.ts";
import type { AgentEvent, RunResult } from "./loop.ts";
import type { Change } from "./tools/types.ts";

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const same = (s: string) => s;
export type Paint = Record<"dim" | "red" | "green" | "yellow" | "cyan" | "bold", (s: string) => string>;
export const paint = (on: boolean): Paint =>
  on
    ? { dim: esc("2"), red: esc("31"), green: esc("32"), yellow: esc("33"), cyan: esc("36"), bold: esc("1") }
    : { dim: same, red: same, green: same, yellow: same, cyan: same, bold: same };

// A terminal that reports no width (or a tiny one) gets a normal line length.
const columns = (out: NodeJS.WriteStream) => (out.columns && out.columns >= 40 ? out.columns : 100);
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

const stripInline = (t: string) => t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

// Renders the model's markdown one whole line at a time. A partial line is held back until
// its newline arrives, because a line can't be restyled once it is on the screen. Table rows
// are held until the table ends, so its columns can be lined up.
export class Markdown {
  private buf = "";
  private fence = false;
  private table: string[] = [];
  private p: Paint;
  constructor(p: Paint) {
    this.p = p;
  }
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
      out += this.take(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
    return out;
  }
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    const out = (rest ? this.take(rest) : "") + this.endTable();
    this.fence = false;
    return out;
  }
  get pending() {
    return this.buf.length > 0 || this.table.length > 0;
  }
  // The unfinished line as typed so far, for showing while it is still being written.
  get raw() {
    return [...this.table, this.buf].filter(Boolean).join("\n");
  }

  private take(l: string): string {
    if (!this.fence && /^\s*\|.*\|\s*$/.test(l)) {
      this.table.push(l);
      return "";
    }
    const line = this.line(l);
    return this.endTable() + (line === null ? "" : line + "\n");
  }

  private endTable(): string {
    if (!this.table.length) return "";
    const rows = this.table.map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    this.table = [];
    const body = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
    const cols = Math.max(...body.map((r) => r.length));
    const width = Array.from({ length: cols }, (_, c) => Math.max(...body.map((r) => stripInline(r[c] ?? "").length)));
    const draw = (r: string[], style: (t: string) => string) => r.map((cell, c) => style(this.inline(cell)) + " ".repeat(width[c] - stripInline(cell).length)).join("   ").trimEnd();
    const [head, ...rest] = body;
    return [draw(head, this.p.bold), this.p.dim(width.map((w) => "─".repeat(w)).join("   ")), ...rest.map((r) => draw(r, (t) => t))].join("\n") + "\n";
  }

  private inline(t: string): string {
    const { bold, cyan, dim } = this.p;
    return t
      .replace(/`([^`]+)`/g, (_, c) => cyan(c))
      .replace(/\*\*([^*]+)\*\*/g, (_, c) => bold(c))
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, (_, lead, c) => `${lead}\x1b[3m${c}\x1b[23m`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `${text} ${dim(`(${url})`)}`);
  }

  // null means the line is markup only and prints nothing.
  private line(l: string): string | null {
    const { dim, bold } = this.p;
    const fence = l.match(/^\s*```\s*(\S*)/);
    if (fence) {
      this.fence = !this.fence;
      return this.fence && fence[1] ? dim(fence[1]) : null;
    }
    if (this.fence) return dim("│ ") + l;
    const heading = l.match(/^#{1,6}\s+(.*)$/);
    if (heading) return bold(heading[1].replace(/\*\*/g, ""));
    const quote = l.match(/^\s*>\s?(.*)$/);
    if (quote) return dim("│ " + stripInline(quote[1]));
    return this.inline(l.replace(/^(\s*)[-*]\s+/, "$1• "));
  }
}

const DIFF_MAX = 60;

// A change as numbered, coloured lines: "  12 + added". Long diffs are cut with a count of what is left.
export function renderDiff(change: Change, p: Paint, max = DIFF_MAX): { lines: string[]; added: number; removed: number } {
  const d = diffLines(change.before, change.after);
  const width = String(Math.max(1, ...d.hunks.flat().map((l) => l.newNo ?? l.oldNo ?? 0))).length;
  const lines: string[] = [];
  d.hunks.forEach((hunk, n) => {
    if (n) lines.push(p.dim(" ".repeat(width) + " ⋮"));
    for (const l of hunk) {
      const row = `${String(l.kind === "-" ? l.oldNo : l.newNo).padStart(width)} ${l.kind} ${l.text}`;
      lines.push(l.kind === "+" ? p.green(row) : l.kind === "-" ? p.red(row) : p.dim(row));
    }
  });
  const cut = lines.length > max ? [...lines.slice(0, max), p.dim(`${" ".repeat(width)} … ${lines.length - max} more lines`)] : lines;
  return { lines: cut, added: d.added, removed: d.removed };
}

export const changeTitle = (c: Change) => (c.before === null ? `Create ${c.path}` : `Edit ${c.path}`);

// The lines of a command's output worth showing: all of a short one, otherwise the end.
export function outputTail(text: string, max: number): { shown: string[]; hidden: number } {
  const body = text.split("\n").filter((l) => l.trim());
  const shown = body.slice(-max);
  return { shown, hidden: body.length - shown.length };
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// One line that redraws in place while nothing else is printing.
export class Status {
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private label = "";
  private detail = "";
  private since = 0;
  private out: NodeJS.WriteStream;
  private p: Paint;
  constructor(out: NodeJS.WriteStream, p: Paint) {
    this.out = out;
    this.p = p;
  }
  start(label: string, detail = "") {
    if (label !== this.label) {
      this.label = label;
      this.since = Date.now();
    }
    this.detail = detail;
    if (this.timer) return;
    this.timer = setInterval(() => this.draw(), 100);
    this.timer.unref?.();
    this.draw();
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.label = "";
    this.out.write("\r\x1b[2K");
  }
  get current() {
    return this.timer ? { label: this.label, detail: this.detail } : null;
  }
  private draw() {
    const width = columns(this.out) - 1;
    const text = `${FRAMES[this.frame++ % FRAMES.length]} ${this.label} · ${secs(Date.now() - this.since)}${this.detail ? ` · ${this.detail}` : ""}`;
    this.out.write("\r\x1b[2K" + this.p.dim(text.length > width ? text.slice(0, width - 1) + "…" : text));
  }
}

export type FileChange = { path: string; added: number; removed: number; created: boolean };
export type RunInfo = { model: string; contextSize: number; wallMs: number; steps: number; lastPrompt: number; lastCompletion: number; tps?: number; changes: FileChange[] };

export const STOP_HELP: Record<string, string> = {
  step_limit: "Stopped at the step limit. The reply above says what is left; type \"continue\" to keep going.",
  stopped: "Type a hint to get it moving again, or /undo to take back this turn's file changes.",
  interrupted: "Interrupted. Type what to do instead, or /undo to take back this turn's file changes.",
  context_full: "The context is full. /compact shortens the conversation so far and keeps going.",
  error: "Nothing was lost; your next message continues the same session.",
};

export class Renderer {
  private p: Paint;
  private fancy: boolean;
  private md: Markdown | null;
  private status: Status;
  private atLineStart = true;
  private thinkStart = 0;
  private toolStart = 0;
  private received = 0;
  private diffShown = false;

  private text: NodeJS.WriteStream;

  // `text` is where the model's own words go: stdout, or stderr when stdout carries JSON.
  constructor(opts: { stdoutTTY: boolean; stderrTTY: boolean; text?: NodeJS.WriteStream }) {
    this.text = opts.text ?? process.stdout;
    this.fancy = opts.stderrTTY;
    this.p = paint(opts.stderrTTY);
    this.md = opts.stdoutTTY && opts.stderrTTY ? new Markdown(this.p) : null;
    this.status = new Status(process.stderr, this.p);
  }

  get colors() {
    return this.p;
  }

  note(line: string) {
    this.quiet();
    process.stderr.write(line + "\n");
  }

  // Clears the status line and ends any half-printed line, before something else prints.
  quiet() {
    this.status.stop();
    if (this.md?.pending) this.text.write(this.md.flush());
    if (!this.atLineStart) this.text.write("\n");
    this.atLineStart = true;
  }

  // Called by the approval prompt; returns a function that puts the status line back.
  pause(): () => void {
    const was = this.status.current;
    this.quiet();
    this.diffShown = true;
    return () => {
      this.toolStart = Date.now(); // time the command, not the wait for an answer
      if (was && this.fancy) this.status.start(was.label, was.detail);
    };
  }

  private lastChange: Change | null = null;
  // A file was written; the tool line that follows shows its diff unless the approval already did.
  changed(change: Change) {
    this.lastChange = change;
  }

  output(chunk: string) {
    if (!this.fancy || !this.status.current) return;
    const last = chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
    if (last) this.status.start(this.status.current.label, oneLine(last, 70));
  }

  onEvent = (e: AgentEvent) => {
    if (!this.fancy) return this.plain(e);
    const { dim, red, green, yellow } = this.p;
    switch (e.type) {
      case "request":
        this.received = 0;
        this.thinkStart = 0;
        this.status.start("waiting for the model");
        break;
      case "thinking":
        this.thinkStart ||= Date.now();
        this.received += e.text.length;
        this.status.start("thinking", `~${kilo(Math.round(this.received / 4))} tokens`);
        break;
      case "calling":
        this.endThinking();
        this.status.start(`writing ${e.name} call`, e.argChars > 400 ? `${kilo(e.argChars)} chars` : "");
        break;
      case "retry":
        this.note(yellow(`Connection problem (${oneLine(e.reason, 80)}). Trying again.`));
        break;
      case "text":
        this.endThinking();
        if (this.md) {
          const ready = this.md.push(e.text);
          if (ready) {
            this.status.stop();
            this.text.write(ready);
          }
          if (this.md.pending) this.status.start("writing");
        } else {
          this.status.stop();
          this.text.write(e.text);
          this.atLineStart = e.text.endsWith("\n");
        }
        break;
      case "turn":
        this.endThinking();
        this.quiet();
        break;
      case "tool_start": {
        this.quiet();
        this.toolStart = Date.now();
        this.diffShown = false;
        const arg = oneLine(String(e.args.command ?? e.args.path ?? e.args.pattern ?? e.args.glob ?? ""), 60);
        this.status.start(e.name === "bash" ? `running ${arg}` : `${e.name} ${arg}`);
        break;
      }
      case "tool": {
        this.quiet();
        const took = Date.now() - this.toolStart;
        const arg = oneLine(String(e.args.command ?? e.args.path ?? e.args.pattern ?? e.args.glob ?? ""), 100);
        const mark = e.result.ok ? green("✓") : red("✗");
        const lines = e.result.text.split("\n");
        if (e.name === "bash" && e.result.ok) {
          const failed = !/^exit code 0$/.test(lines[0]);
          const { shown, hidden } = outputTail(lines.slice(1).join("\n"), failed ? 15 : 8);
          process.stderr.write(`${failed ? yellow("!") : mark} ${this.p.bold("bash")} ${arg}  ${dim(`${lines[0]} · ${secs(took)}`)}\n`);
          if (hidden) process.stderr.write(dim(`  … ${hidden} earlier lines\n`));
          for (const l of shown) process.stderr.write(dim("  " + oneLine(l, columns(process.stderr) - 4)) + "\n");
        } else if ((e.name === "edit" || e.name === "write") && e.result.ok) {
          const d = this.lastChange ? renderDiff(this.lastChange, this.p) : null;
          process.stderr.write(`${mark} ${this.p.bold(e.name)} ${String(e.args.path ?? "")}${d ? `  ${green(`+${d.added}`)}${d.removed ? red(` −${d.removed}`) : ""}` : ""}\n`);
          if (d && !this.diffShown) process.stderr.write(indent(d.lines.join("\n")) + "\n");
          this.lastChange = null;
        } else {
          // read and search return content, so say how much came back instead of quoting it.
          const got = lines.length === 1 ? oneLine(lines[0], 100) : `${e.name === "read" ? lines.length - 1 : lines.length} lines`;
          process.stderr.write(`${mark} ${this.p.bold(e.name)} ${arg}  ${e.result.ok ? dim(got) : lines[0].startsWith("Plan mode") ? yellow("not run: plan mode") : red(oneLine(lines[0], 160))}\n`);
        }
        break;
      }
    }
  };

  private endThinking() {
    if (!this.thinkStart) return;
    const took = Date.now() - this.thinkStart;
    this.thinkStart = 0;
    if (took < 2000) return;
    this.status.stop();
    process.stderr.write(this.p.dim(`thought for ${secs(took)}`) + "\n");
  }

  // The format the eval logs were built on. Keep it stable.
  private plain(e: AgentEvent) {
    if (e.type === "text") {
      this.text.write(e.text);
      this.atLineStart = e.text.endsWith("\n");
    } else if (e.type === "tool") {
      this.quiet();
      const arg = String(e.args.path ?? e.args.command ?? e.args.pattern ?? e.args.glob ?? "").split("\n")[0].slice(0, 100);
      process.stderr.write(`→ ${e.name} ${arg}  ${e.result.text.split("\n")[0].slice(0, 120)}\n`);
    } else if (e.type === "turn") {
      const u = e.usage;
      const cached = u.prompt ? Math.round((100 * u.cached) / u.prompt) : 0;
      const prefill = u.prefillMs !== undefined ? ` · prefill ${(u.prefillMs / 1000).toFixed(1)} s` : "";
      const tps = u.genTps ? ` · ${u.genTps.toFixed(0)} tok/s` : "";
      this.quiet();
      process.stderr.write(`[step ${e.step} · ${u.prompt} prompt tokens, ${cached}% cached${prefill}${tps} · ${(e.ms / 1000).toFixed(1)} s]\n`);
    }
  }

  // After a run: why it stopped (if it didn't finish), the files it changed, and one status line.
  finish(result: RunResult | { status: "error"; reason: string }, info: RunInfo) {
    this.quiet();
    const { dim, red, yellow, green } = this.p;
    if (result.status !== "done") {
      const reason = "reason" in result && result.reason ? `: ${result.reason}` : "";
      process.stderr.write(red(`[${result.status}]${reason}`) + "\n");
      if (this.fancy) process.stderr.write(dim(STOP_HELP[result.status] ?? "") + "\n");
    }
    if (!this.fancy) return;
    if (info.changes.length) {
      const list = info.changes.map((c) => `${c.path} ${green(`+${c.added}`)}${c.removed ? red(` −${c.removed}`) : ""}${c.created ? dim(" new") : ""}`);
      process.stderr.write(`${dim(`changed ${info.changes.length} file${info.changes.length > 1 ? "s" : ""}:`)} ${list.join(dim(", "))}\n`);
    }
    const used = info.lastPrompt + info.lastCompletion;
    const pct = info.contextSize ? Math.round((100 * used) / info.contextSize) : 0;
    const context = `${kilo(used)} of ${kilo(info.contextSize)} context (${pct}%)`;
    const parts = [info.model, `${info.steps} step${info.steps === 1 ? "" : "s"}`, secs(info.wallMs), pct >= 70 ? yellow(`${context}, /compact frees it`) : context];
    if (info.tps) parts.push(`${info.tps.toFixed(0)} tok/s`);
    process.stderr.write(dim(parts.join(" · ")) + "\n");
  }
}

const indent = (s: string) => s.split("\n").map((l) => "  " + l).join("\n");
