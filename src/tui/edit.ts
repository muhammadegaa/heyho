// Text editing for the input box: a value and a cursor position, and the keys that change them.
export type Edit = { value: string; cursor: number };

export const EMPTY: Edit = { value: "", cursor: 0 };
export const at = (value: string): Edit => ({ value, cursor: value.length });

const lineStart = (e: Edit) => e.value.lastIndexOf("\n", e.cursor - 1) + 1;
const lineEnd = (e: Edit) => {
  const i = e.value.indexOf("\n", e.cursor);
  return i < 0 ? e.value.length : i;
};

export const insert = (e: Edit, text: string): Edit => ({ value: e.value.slice(0, e.cursor) + text + e.value.slice(e.cursor), cursor: e.cursor + text.length });
export const backspace = (e: Edit): Edit => (e.cursor ? { value: e.value.slice(0, e.cursor - 1) + e.value.slice(e.cursor), cursor: e.cursor - 1 } : e);
export const del = (e: Edit): Edit => ({ value: e.value.slice(0, e.cursor) + e.value.slice(e.cursor + 1), cursor: e.cursor });
export const left = (e: Edit): Edit => ({ ...e, cursor: Math.max(0, e.cursor - 1) });
export const right = (e: Edit): Edit => ({ ...e, cursor: Math.min(e.value.length, e.cursor + 1) });
export const home = (e: Edit): Edit => ({ ...e, cursor: lineStart(e) });
export const end = (e: Edit): Edit => ({ ...e, cursor: lineEnd(e) });
export const killToEnd = (e: Edit): Edit => ({ value: e.value.slice(0, e.cursor) + e.value.slice(lineEnd(e)), cursor: e.cursor });
export const killToStart = (e: Edit): Edit => {
  const s = lineStart(e);
  return { value: e.value.slice(0, s) + e.value.slice(e.cursor), cursor: s };
};
export const killWord = (e: Edit): Edit => {
  const before = e.value.slice(0, e.cursor).replace(/\s+$/, "");
  const s = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("/")) + 1;
  return { value: e.value.slice(0, s) + e.value.slice(e.cursor), cursor: s };
};

// Up and down move between lines of a multi-line message; null means the cursor is already
// on the first or last line, so the key should go to history instead.
export function vertical(e: Edit, dir: -1 | 1): Edit | null {
  const s = lineStart(e);
  const col = e.cursor - s;
  if (dir < 0) {
    if (s === 0) return null;
    const prevStart = e.value.lastIndexOf("\n", s - 2) + 1;
    return { ...e, cursor: Math.min(prevStart + col, s - 1) };
  }
  const en = lineEnd(e);
  if (en === e.value.length) return null;
  const nextEnd = e.value.indexOf("\n", en + 1);
  return { ...e, cursor: Math.min(en + 1 + col, nextEnd < 0 ? e.value.length : nextEnd) };
}

// The "@partial" being typed at the cursor, if any.
export function atToken(e: Edit): { start: number; query: string } | null {
  const m = e.value.slice(0, e.cursor).match(/(^|\s)@(\S*)$/);
  return m ? { start: e.cursor - m[2].length - 1, query: m[2] } : null;
}
export const replaceToken = (e: Edit, start: number, text: string): Edit => {
  const value = e.value.slice(0, start) + text + e.value.slice(e.cursor);
  return { value, cursor: start + text.length };
};

// Matches for a menu: names that start with the query first, then names that contain it.
export function rank(names: string[], query: string, max: number): string[] {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, max);
}
