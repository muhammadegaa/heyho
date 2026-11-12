// A session is a JSONL file: one meta line, then every message and usage record in order.
// A {reset:true} line means the messages before it were dropped (/clear, /compact).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CARRY_ON, NOTES_PREFIX } from "./compact.ts";
import type { Message } from "./model.ts";

export type Session = { file: string; record: (entry: object) => void };

export function newSession(stateDir: string): Session {
  const dir = join(stateDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  return { file, record: (entry) => appendFileSync(file, JSON.stringify({ t: Date.now(), ...entry }) + "\n") };
}

export function loadMessages(file: string): Message[] {
  let messages: Message[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const { t: _t, ...entry } = JSON.parse(line);
    if (entry.reset) messages = [];
    else if (typeof entry.role === "string") messages.push(entry as Message);
  }
  return messages;
}

export type SessionInfo = { file: string; when: Date; first: string; turns: number };

// What the user typed in a session, in order: every user message in the file, including ones
// later dropped by /compact, minus the messages heyho writes itself.
function prompts(file: string): { texts: string[]; headless: boolean } {
  const texts: string[] = [];
  let headless = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.meta?.headless) headless = true;
    if (entry.role !== "user" || typeof entry.content !== "string") continue;
    if (entry.content.startsWith(NOTES_PREFIX) || entry.content === CARRY_ON) continue;
    if (!texts.includes(entry.content)) texts.push(entry.content); // a resumed session repeats its history
  }
  return { texts, headless };
}

// Newest first. Sessions with no user message are left out, and so are one-off headless
// runs unless asked for.
export function listSessions(stateDir: string, limit = 10, opts: { headless?: boolean } = {}): SessionInfo[] {
  const dir = join(stateDir, "sessions");
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().reverse()) {
    const file = join(dir, name);
    const { texts, headless } = prompts(file);
    if (!texts.length || (headless && !opts.headless)) continue;
    const stamp = name.slice(0, -6).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z");
    out.push({ file, when: new Date(stamp), first: texts[0].replace(/^\[[^\]]*\]\s*/, "").split("\n")[0].slice(0, 70), turns: texts.length });
    if (out.length >= limit) break;
  }
  return out;
}
