// Vim-style editing for the input box, for people who set "editorMode": "vim". Normal mode
// covers moving (h l w b e 0 $ j k), entering insert (i a I A o O), deleting, changing and
// copying (x D C, and d c y with a motion or doubled), pasting (p P), undoing the last change
// made in normal mode (u), and a count before any of them (3w, 2dd, d2w). There is no visual
// mode and one register. Anything else is ignored.
import * as ed from "./edit.ts";
import type { Edit } from "./edit.ts";

// `pending` is what has been typed of a command so far: a count, an operator, a second count.
export type VimState = { edit: Edit; insert: boolean; pending: string; register?: { text: string; lines: boolean }; undo?: Edit[] };

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

// Just past the end of the word at or after the cursor.
const wordEnd = (e: Edit): number => e.cursor + (e.value.slice(e.cursor).match(/^\s*\S+/) ?? [""])[0].length;

// Where a motion key takes the cursor, or null if the key is not a motion.
function motion(e: Edit, key: string): number | null {
  switch (key) {
    case "h":
      return ed.left(e).cursor;
    case "l":
      return ed.right(e).cursor;
    case "0":
      return ed.home(e).cursor;
    case "$":
      return ed.end(e).cursor;
    case "w":
      return wordForward(e);
    case "b":
      return wordBack(e);
    case "e":
      return Math.max(e.cursor, wordEnd({ ...e, cursor: Math.min(e.value.length, e.cursor + 1) }) - 1);
    default:
      return null;
  }
}

// One key in normal mode. Returns null for j or k at the edge of the text, so the caller
// can move through history instead.
export function normalKey(s: VimState, key: string): VimState | null {
  const e = s.edit;
  const keep = { register: s.register, undo: s.undo ?? [] };
  // A change is remembered so that u can take it back.
  const done = (edit: Edit, insert = false, register = keep.register): VimState => ({ edit: clamp(edit), insert, pending: "", register, undo: edit.value === e.value ? keep.undo : [...keep.undo.slice(-49), e] });
  const wait = (pending: string): VimState => ({ edit: e, insert: false, pending, ...keep });

  const [, n1 = "", op = "", n2 = ""] = s.pending.match(/^(\d*)([dcy]?)(\d*)$/) ?? [];
  if (/[1-9]/.test(key) || (key === "0" && (op ? n2 : n1))) return wait(s.pending + key);
  const count = Math.max(1, Number(n1 || 1) * Number(n2 || 1));
  const repeat = (step: (at: Edit) => Edit): Edit => {
    let at = e;
    for (let i = 0; i < count; i++) at = step(at);
    return at;
  };

  if (op) {
    const lineStart = ed.home(e).cursor;
    let from: number;
    let to: number;
    let lines = false;
    if (key === op) {
      // dd, cc, yy: whole lines, `count` of them.
      lines = true;
      from = lineStart;
      to = ed.end(e).cursor;
      for (let i = 1; i < count && to < e.value.length; i++) to = ed.end({ ...e, cursor: to + 1 }).cursor;
    } else {
      const target = key === "w" && op === "c" ? repeat((at) => ({ ...at, cursor: wordEnd(at) })).cursor : motion(e, key) === null ? null : repeat((at) => ({ ...at, cursor: motion(at, key)! })).cursor;
      if (target === null) return done(e);
      [from, to] = target < e.cursor ? [target, e.cursor] : [e.cursor, target + (key === "e" ? 1 : 0)];
    }
    const text = e.value.slice(from, to);
    const register = { text, lines };
    if (op === "y") return done({ ...e, cursor: lines ? e.cursor : from }, false, register);
    // dd also takes the line break, so the line goes and not just its text.
    const cutTo = lines && op === "d" ? (e.value[to] === "\n" ? to + 1 : to) : to;
    const cutFrom = lines && op === "d" && cutTo === to && from > 0 ? from - 1 : from;
    return done({ value: e.value.slice(0, cutFrom) + e.value.slice(cutTo), cursor: Math.min(from, cutFrom === from ? from : ed.home({ ...e, cursor: cutFrom }).cursor) }, op === "c", register);
  }

  const moved = motion(e, key);
  if (moved !== null) return done(repeat((at) => ({ ...at, cursor: motion(at, key)! })));
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
    case "j":
    case "k": {
      const next = ed.vertical(e, key === "j" ? 1 : -1);
      return next ? done(next) : null;
    }
    case "x":
      return done({ value: e.value.slice(0, e.cursor) + e.value.slice(e.cursor + count), cursor: e.cursor }, false, { text: e.value.slice(e.cursor, e.cursor + count), lines: false });
    case "D":
      return done(ed.killToEnd(e), false, { text: e.value.slice(e.cursor, ed.end(e).cursor), lines: false });
    case "C":
      return done(ed.killToEnd(e), true);
    case "p":
    case "P": {
      const r = keep.register;
      if (!r) return done(e);
      const text = r.text.repeat(count);
      if (r.lines) {
        const at = key === "p" ? ed.end(e).cursor : ed.home(e).cursor;
        return key === "p" ? done({ value: e.value.slice(0, at) + "\n" + text + e.value.slice(at), cursor: at + 1 }) : done({ value: e.value.slice(0, at) + text + "\n" + e.value.slice(at), cursor: at });
      }
      const at = key === "p" ? Math.min(e.value.length, e.cursor + 1) : e.cursor;
      return done({ value: e.value.slice(0, at) + text + e.value.slice(at), cursor: at + text.length - 1 });
    }
    case "u": {
      const last = keep.undo.at(-1);
      return last ? { edit: last, insert: false, pending: "", register: keep.register, undo: keep.undo.slice(0, -1) } : done(e);
    }
    case "d":
    case "c":
    case "y":
      return wait(s.pending + key);
    default:
      return done(e);
  }
}
