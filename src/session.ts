// A session is a JSONL file: one meta line, then every message and usage record in order.
// A {reset:true} line means the messages before it were dropped (/clear, /compact).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARRY_ON, NOTES_PREFIX } from "./compact.ts";
import type { Message } from "./model.ts";

export type Session = { file: string; record: (entry: object) => void };

export function newSession(stateDir: string): Session {
  const dir = join(stateDir, "sessions");
  mkdirSync(dir, { recursive: true });
  // Two sessions opened in the same millisecond would share a file; the later one takes the next free one.
  const name = (t: number) => join(dir, `${new Date(t).toISOString().replace(/[:.]/g, "-")}.jsonl`);
  let at = Date.now();
  while (existsSync(name(at))) at++;
  const file = name(at);
  writeFileSync(file, "");
  return { file, record: (entry) => appendFileSync(file, JSON.stringify({ t: Date.now(), ...entry }) + "\n") };
}

// Where a turn began: enough to put the conversation and the files back to that point.
export type Checkpoint = { text: string; messages: number; turn: number };
export type FileEntry = { before: string | null; after: string };
export type Loaded = { messages: Message[]; checkpoints: Checkpoint[]; turns: Map<string, FileEntry>[]; name?: string; mode?: string };

// Replays a session file. Besides messages it holds: `checkpoints` (the full list, written
// whenever it changes), `change` (one file write in a turn), `turns` (how many turns of
// changes are left after an undo) and `name`.
export function loadSession(file: string): Loaded {
  const out: Loaded = { messages: [], checkpoints: [], turns: [] };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const { t: _t, ...entry } = JSON.parse(line);
    if (entry.reset) out.messages = [];
    else if (typeof entry.role === "string") out.messages.push(entry as Message);
    else if (entry.checkpoints) out.checkpoints = entry.checkpoints;
    else if (entry.change) {
      while (out.turns.length <= entry.change.turn) out.turns.push(new Map());
      const turn = out.turns[entry.change.turn];
      turn.set(entry.change.path, { before: turn.get(entry.change.path)?.before ?? entry.change.before, after: entry.change.after });
    } else if (typeof entry.turns === "number") out.turns.length = Math.min(out.turns.length, entry.turns);
    else if (typeof entry.name === "string") out.name = entry.name;
    else if (entry.meta?.mode) out.mode = entry.meta.mode;
  }
  return out;
}

export const loadMessages = (file: string): Message[] => loadSession(file).messages;

// `first` is the session's name if it was given one, otherwise the start of its first message.
export type SessionInfo = { file: string; when: Date; first: string; turns: number };

// What the user typed in a session, in order: every user message in the file, including ones
// later dropped by /compact, minus the messages heyho writes itself.
// `title` is the first message of the conversation, which a reopened session carries in its
// rewind points even after /compact dropped the message itself. `from` is the file it reopened.
function prompts(file: string): { texts: string[]; headless: boolean; name?: string; title?: string; from?: string } {
  const texts: string[] = [];
  let headless = false;
  let name: string | undefined;
  let title: string | undefined;
  let from: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.meta?.headless) headless = true;
    if (typeof entry.name === "string") name = entry.name;
    if (typeof entry.from === "string") from = entry.from;
    if (entry.checkpoints?.length) title ??= entry.checkpoints[0].text;
    if (entry.role !== "user" || typeof entry.content !== "string") continue;
    if (entry.content.startsWith(NOTES_PREFIX) || entry.content === CARRY_ON) continue;
    if (!texts.includes(entry.content)) texts.push(entry.content); // a resumed session repeats its history
  }
  return { texts, headless, name, title, from };
}

// Newest first. Sessions with no user message are left out, and so are one-off headless
// runs unless asked for.
export function listSessions(stateDir: string, limit = 10, opts: { headless?: boolean } = {}): SessionInfo[] {
  const dir = join(stateDir, "sessions");
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  const reopened = new Set<string>(); // files a newer session carries on from
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().reverse()) {
    const file = join(dir, name);
    const { texts, headless, name: given, title, from } = prompts(file);
    if (title && !texts.length) texts.push(title);
    if (!texts.length || (headless && !opts.headless)) continue;
    if (from) reopened.add(from);
    if (reopened.has(name)) continue;
    const stamp = name.slice(0, -6).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z");
    out.push({ file, when: new Date(stamp), first: given ?? (title ?? texts[0]).replace(/^\[[^\]]*\]\s*/, "").split("\n")[0].slice(0, 70), turns: texts.length });
    if (out.length >= limit) break;
  }
  return out;
}
