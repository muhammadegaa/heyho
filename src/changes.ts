// Tracks the files each user turn wrote, for the end-of-run summary and /undo.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { diffLines } from "./diff.ts";
import type { FileChange } from "./ui.ts";

type Entry = { before: string | null; after: string };

export class Changes {
  private turns: Map<string, Entry>[] = [];
  private root: string;
  constructor(root: string) {
    this.root = root;
  }

  startTurn() {
    this.turns.push(new Map());
  }

  record = (abs: string, before: string | null, after: string) => {
    const turn = this.turns.at(-1);
    if (!turn) return;
    const first = turn.get(abs);
    turn.set(abs, { before: first ? first.before : before, after });
  };

  get turnCount() {
    return this.turns.length;
  }

  // Undoes every turn from the latest back to and including turn number `to` (0-based).
  rewindTo(to: number): { restored: string[]; skipped: string[] } {
    const restored = new Set<string>();
    const skipped = new Set<string>();
    while (this.turns.length > to) {
      const r = this.undoTurn(this.turns.pop()!);
      r.restored.forEach((f) => restored.add(f));
      r.skipped.forEach((f) => skipped.add(f));
    }
    return { restored: [...restored], skipped: [...skipped] };
  }

  summary(): FileChange[] {
    return [...(this.turns.at(-1) ?? [])].map(([abs, e]) => {
      const { added, removed } = diffLines(e.before, e.after);
      return { path: relative(this.root, abs), added, removed, created: e.before === null };
    });
  }

  // Restores the files of the most recent turn that changed any. A file edited since
  // (by the user or a command) is left alone. Commands the agent ran are not undone.
  undo(): { restored: string[]; skipped: string[] } | null {
    while (this.turns.length && !this.turns.at(-1)!.size) this.turns.pop();
    const turn = this.turns.pop();
    return turn ? this.undoTurn(turn) : null;
  }

  private undoTurn(turn: Map<string, Entry>): { restored: string[]; skipped: string[] } {
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const [abs, e] of turn) {
      const shown = relative(this.root, abs);
      if (!existsSync(abs) || readFileSync(abs, "utf8") !== e.after) {
        skipped.push(shown);
        continue;
      }
      if (e.before === null) rmSync(abs);
      else writeFileSync(abs, e.before);
      restored.push(shown);
    }
    return { restored, skipped };
  }
}
