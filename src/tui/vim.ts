// Vim-style editing for the input box, for people who set "editorMode": "vim". Normal mode
// covers moving (h l w b 0 $ j k), entering insert (i a I A o O), and deleting or changing
// (x D C dd dw cw cc). Anything else is ignored.
import * as ed from "./edit.ts";
import type { Edit } from "./edit.ts";

export type VimState = { edit: Edit; insert: boolean; pending: string };

const wordForward = (e: Edit): number => {
  const rest = e.value.slice(e.cursor);
  const m = rest.match(/^\s*\S+\s*/) ?? [""];
  const skip = /^\s/.test(rest) ? (rest.match(/^\s+/) ?? [""])[0].length : m[0].length;
  return Math.min(e.value.length, e.cursor + skip);
};
const wordBack = (e: Edit): number => {
  const before = e.value.slice(0, e.cursor).replace(/\s+$/, "");
  return before.search(/\S+$/) < 0 ? 0 : before.search(/\S+$/);
};
const clamp = (e: Edit): Edit => ({ ...e, cursor: Math.max(0, Math.min(e.cursor, e.value.length)) });

// One key in normal mode. Returns null for j or k at the edge of the text, so the caller
// can move through history instead.
export function normalKey(s: VimState, key: string): VimState | null {
  const e = s.edit;
  const done = (edit: Edit, insert = false): VimState => ({ edit: clamp(edit), insert, pending: "" });
  if (s.pending) {
    const combo = s.pending + key;
    const lineStart = ed.home(e).cursor;
    const lineEnd = ed.end(e).cursor;
    if (combo === "dd" || combo === "cc") {
      const cutEnd = combo === "dd" && e.value[lineEnd] === "\n" ? lineEnd + 1 : lineEnd;
      return done({ value: e.value.slice(0, lineStart) + e.value.slice(cutEnd), cursor: lineStart }, combo === "cc");
    }
    if (combo === "dw" || combo === "cw") {
      const to = combo === "cw" ? e.cursor + (e.value.slice(e.cursor).match(/^\S+/) ?? [""])[0].length : wordForward(e);
      return done({ value: e.value.slice(0, e.cursor) + e.value.slice(to), cursor: e.cursor }, combo === "cw");
    }
    return done(e);
  }
  switch (key) {
    case "i":
      return done(e, true);
    case "a":
      return done(ed.right(e), true);
    case "I":
      return done(ed.home(e), true);
    case "A":
      return done(ed.end(e), true);
    case "o":
      return done(ed.insert(ed.end(e), "\n"), true);
    case "O":
      return done(ed.left(ed.insert(ed.home(e), "\n")), true);
    case "h":
      return done(ed.left(e));
    case "l":
      return done(ed.right(e));
    case "0":
      return done(ed.home(e));
    case "$":
      return done(ed.end(e));
    case "w":
      return done({ ...e, cursor: wordForward(e) });
    case "b":
      return done({ ...e, cursor: wordBack(e) });
    case "j":
    case "k": {
      const moved = ed.vertical(e, key === "j" ? 1 : -1);
      return moved ? done(moved) : null;
    }
    case "x":
      return done(ed.del(e));
    case "D":
      return done(ed.killToEnd(e));
    case "C":
      return done(ed.killToEnd(e), true);
    case "d":
    case "c":
      return { edit: e, insert: false, pending: key };
    default:
      return done(e);
  }
}
