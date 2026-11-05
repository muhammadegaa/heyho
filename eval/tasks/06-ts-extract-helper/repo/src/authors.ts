import type { Author } from "./types";

function shownName(author: Author): string {
  return author.displayName.trim() || author.email.split("@")[0];
}

export function authorHandle(author: Author): string {
  let handle = shownName(author).normalize("NFKD");
  handle = handle.replace(/[\u0300-\u036f]/g, "").toLowerCase();
  handle = handle
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const limit = 40;
  if (handle.length > limit) {
    handle = handle.slice(0, limit).replace(/-+$/, "");
  }
  return handle || `user-${author.id}`;
}

export function byline(author: Author): string {
  return `${shownName(author)} (@${authorHandle(author)})`;
}
