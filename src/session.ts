// A session is a JSONL file: one meta line, then every message and usage record in order.
// A {reset:true} line means the messages before it were dropped (/clear, /compact).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// Newest first. Sessions with no user message are left out.
export function listSessions(stateDir: string, limit = 10): SessionInfo[] {
  const dir = join(stateDir, "sessions");
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().reverse()) {
    const file = join(dir, name);
    const users = loadMessages(file).filter((m) => m.role === "user");
    if (!users.length) continue;
    const stamp = name.slice(0, -6).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z");
    out.push({ file, when: new Date(stamp), first: String(users[0].content).split("\n")[0].slice(0, 70), turns: users.length });
    if (out.length >= limit) break;
  }
  return out;
}
