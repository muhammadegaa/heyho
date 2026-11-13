// The state behind the Ink screen. Finished things become transcript items, printed once and
// left to the terminal's own scrollback; what is still changing lives in `live`.
import type { ApprovalAnswer, ApprovalRequest, Outcome } from "../app.ts";
import type { AgentEvent } from "../loop.ts";
import type { Change, Todo } from "../tools/types.ts";
import { Markdown, outputTail, paint, renderDiff, STOP_HELP, type RunInfo } from "../ui.ts";

const p = paint(true);
const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
export const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

// `mark` is printed once at the left; `text` wraps beside it with a hanging indent.
export type Item = { id: number; mark: string; text: string; gap?: boolean };
export type Activity = { label: string; detail: string; since: number };
export type Pending = { request: ApprovalRequest; resolve: (a: ApprovalAnswer) => void };

export type Asking = { question: string; options: string[]; resolve: (answer: string) => void };

export type Live = {
  todos: Todo[];
  asking: Asking | null; // the model's question for the user
  activity: Activity | null;
  partial: string; // the line of the reply still being written
  pending: Pending | null;
  queue: string[];
};

const DIFF_IN_TRANSCRIPT = 40;
const OUTPUT_EXPANDED = 200;

export class Store {
  root = ""; // paths under it are shown relative
  items: Item[] = [];
  live: Live = { todos: [], asking: null, activity: null, partial: "", pending: null, queue: [] };
  private listeners = new Set<() => void>();
  private nextId = 1;
  private md = new Markdown(p);
  private p = (s: string) => p.cyan(s);
  private replyStarted = false;
  private thinkStart = 0;
  private received = 0;
  private toolStart = 0;
  private lastChange: Change | null = null;
  private lastOutput: { title: string; text: string } | null = null;
  version = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
  update(change: (live: Live) => void) {
    change(this.live);
    this.emit();
  }

  add(mark: string, text: string, gap = false) {
    this.items = [...this.items, { id: this.nextId++, mark, text, gap }];
    this.emit();
  }
  note(text: string, tone: "dim" | "warn" | "error" | "plain" = "plain") {
    this.add(" ", tone === "dim" ? p.dim(text) : tone === "warn" ? p.yellow(text) : tone === "error" ? p.red(text) : text);
  }
  user(text: string) {
    this.add(p.bold("›"), p.bold(text), true);
  }

  // What a tool was called with, as short as it can be shown.
  private arg(args: Record<string, unknown>, max: number) {
    const raw = String(args.command ?? args.path ?? args.pattern ?? args.glob ?? args.url ?? args.tool ?? "");
    return oneLine(this.root ? raw.split(this.root + "/").join("").split(this.root).join(".") : raw, max);
  }

  private activity(label: string, detail = "") {
    const a = this.live.activity;
    this.live.activity = { label, detail, since: a && a.label === label ? a.since : Date.now() };
  }

  private replyLine(line: string) {
    this.add(this.replyStarted ? " " : "⏺", line, !this.replyStarted);
    this.replyStarted = true;
  }
  // Ends the reply in progress: whatever is left of the last line is printed.
  private endReply() {
    const rest = this.md.flush();
    if (rest) for (const line of rest.replace(/\n$/, "").split("\n")) this.replyLine(line);
    this.live.partial = "";
    this.replyStarted = false;
  }
  private endThinking() {
    if (!this.thinkStart) return;
    const took = Date.now() - this.thinkStart;
    this.thinkStart = 0;
    if (took >= 2000) this.add(" ", p.dim(`thought for ${secs(took)}`));
  }

  changed = (change: Change) => {
    this.lastChange = change;
  };
  output = (chunk: string) => {
    const last = chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
    if (last && this.live.activity) this.update((l) => (l.activity!.detail = oneLine(last, 60)));
  };

  onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "request":
        this.received = 0;
        this.activity("waiting for the model");
        break;
      case "thinking":
        this.thinkStart ||= Date.now();
        this.received += e.text.length;
        this.activity("thinking", `~${kilo(Math.round(this.received / 4))} tokens`);
        break;
      case "calling":
        this.endThinking();
        this.activity(`writing ${e.name} call`, e.argChars > 400 ? `${kilo(e.argChars)} chars` : "");
        break;
      case "retry":
        this.note(`Connection problem (${oneLine(e.reason, 80)}). Trying again.`, "warn");
        break;
      case "text": {
        this.endThinking();
        this.live.activity = null;
        const whole = this.md.push(e.text);
        if (whole) for (const line of whole.replace(/\n$/, "").split("\n")) this.replyLine(line);
        this.live.partial = this.md.raw;
        break;
      }
      case "turn":
        this.endThinking();
        this.endReply();
        this.live.activity = null;
        break;
      case "tool_start": {
        this.endReply();
        this.toolStart = Date.now();
        const arg = this.arg(e.args, 60);
        this.activity(e.name === "bash" ? `running ${arg}` : `${e.name} ${arg}`);
        break;
      }
      case "tool": {
        this.live.activity = null;
        const took = Date.now() - this.toolStart;
        const arg = this.arg(e.args, 100);
        const lines = e.result.text.split("\n");
        const head = `${p.bold(e.name)} ${arg}`;
        if (!e.result.ok) {
          this.add(p.red("⏺"), `${head}\n${lines[0].startsWith("Plan mode") ? p.yellow("not run: plan mode") : lines[0].startsWith("Blocked:") ? p.yellow(oneLine(lines[0].replace(/\. Do not try.*$|\. Carry on.*$/, ""), 200)) : lines[0].startsWith("The user declined") ? p.yellow(oneLine(lines[0].replace(/^The user declined this action( and said: )?/, (_, said) => (said ? "you said: " : "declined")).replace(/^\. Ask what.*$/, ""), 300)) : p.red(oneLine(lines[0], 300))}`);
        } else if (e.name === "bash") {
          const failed = lines[0] !== "exit code 0";
          const body = lines.slice(1).join("\n");
          const { shown, hidden } = outputTail(body, failed ? 15 : 3);
          this.lastOutput = { title: arg, text: body };
          const tail = hidden && !failed ? p.dim(`${shown.length + hidden} lines of output (ctrl+o shows them)`) : [hidden ? p.dim(`… ${hidden} earlier lines (ctrl+o shows them)`) : "", ...shown.map((l) => p.dim(l))].filter(Boolean).join("\n");
          this.add(failed ? p.yellow("⏺") : p.green("⏺"), `${head}  ${p.dim(`${lines[0]} · ${secs(took)}`)}${tail ? "\n" + tail : ""}`);
        } else if (e.name === "edit" || e.name === "write") {
          const d = this.lastChange ? renderDiff(this.lastChange, p, DIFF_IN_TRANSCRIPT) : null;
          this.lastChange = null;
          const counts = d ? `  ${p.green(`+${d.added}`)}${d.removed ? p.red(` −${d.removed}`) : ""}` : "";
          this.add(p.green("⏺"), `${p.bold(e.name)} ${arg}${counts}${d ? "\n" + d.lines.join("\n") : ""}`);
        } else {
          if (e.name === "todo" || e.name === "ask") break; // the checklist and the answer are shown as they are
          const got = lines.length === 1 ? oneLine(lines[0], 100) : `${e.name === "read" ? lines.length - 1 : lines.length} lines`;
          this.add(p.green("⏺"), `${head}  ${p.dim(got)}`);
        }
        break;
      }
    }
    this.emit();
  };

  // Prints the full output of the most recent command.
  expandOutput() {
    if (!this.lastOutput) return this.note("No command output to show yet.", "dim");
    const lines = this.lastOutput.text.split("\n");
    const cut = lines.length > OUTPUT_EXPANDED ? [...lines.slice(0, OUTPUT_EXPANDED), p.dim(`… ${lines.length - OUTPUT_EXPANDED} more lines`)] : lines;
    this.add(p.dim("⏺"), `${p.dim(`output of ${this.lastOutput.title}`)}\n${cut.join("\n")}`);
  }

  finish(result: Outcome, info: RunInfo) {
    this.endThinking();
    this.endReply();
    this.live.activity = null;
    if (result.status !== "done") {
      const reason = "reason" in result && result.reason ? `: ${result.reason}` : "";
      this.add(" ", `${p.red(`[${result.status}]${reason}`)}\n${p.dim(STOP_HELP[result.status] ?? "")}`);
    }
    const parts: string[] = [];
    if (info.changes.length)
      parts.push(`${p.dim(`changed ${info.changes.length} file${info.changes.length > 1 ? "s" : ""}:`)} ${info.changes.map((c) => `${c.path} ${p.green(`+${c.added}`)}${c.removed ? p.red(` −${c.removed}`) : ""}`).join(p.dim(", "))}`);
    parts.push(p.dim([`worked for ${secs(info.wallMs)}`, `${info.steps} step${info.steps === 1 ? "" : "s"}`, info.tps ? `${info.tps.toFixed(0)} tok/s` : ""].filter(Boolean).join(" · ")));
    this.add(" ", parts.join("\n"), true);
  }

  todos = (items: Todo[]) => this.update((l) => (l.todos = items));

  question = (question: string, options: string[]): Promise<string> =>
    new Promise((resolve) => {
      const was = this.live.activity;
      this.endReply();
      this.update((l) => {
        l.activity = null;
        l.asking = {
          question,
          options,
          resolve: (answer) => {
            this.add(this.p("?"), `${question}\n${this.p(answer)}`, true);
            this.update((x) => ((x.asking = null), (x.activity = was ? { ...was, since: Date.now() } : null)));
            resolve(answer);
          },
        };
      });
    });

  ask = (request: ApprovalRequest): Promise<ApprovalAnswer> =>
    new Promise((resolve) => {
      const was = this.live.activity;
      this.endReply();
      this.update((l) => {
        l.activity = null;
        l.pending = {
          request,
          resolve: (a) => {
            this.toolStart = Date.now(); // time the command, not the wait for an answer
            this.update((x) => ((x.pending = null), (x.activity = was ? { ...was, since: Date.now() } : null)));
            resolve(a);
          },
        };
      });
    });
}
