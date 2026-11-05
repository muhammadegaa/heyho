import { normalizeTags } from "./tags";
import type { Post, PostInput } from "./types";

const MAX_SLUG_LENGTH = 60;

/** A URL slug for a post title, made unique against `taken` by appending -2, -3, ... */
export function postSlug(title: string, taken: ReadonlySet<string> = new Set()): string {
  let base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length > MAX_SLUG_LENGTH) {
    base = base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  }
  if (base === "") base = "untitled";

  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    slug = `${base}-${n}`;
  }
  return slug;
}

export function excerpt(body: string, maxWords = 30): string {
  const words = body
    .replace(/[#*_`>]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

export function createPost(input: PostInput, existing: readonly Post[]): Post {
  const title = input.title.trim();
  if (!title) throw new Error("a post needs a title");
  const taken = new Set(existing.map((post) => post.slug));
  return {
    id: Math.max(0, ...existing.map((post) => post.id)) + 1,
    title,
    slug: postSlug(title, taken),
    body: input.body,
    authorId: input.authorId,
    tags: normalizeTags(input.tags ?? []),
    publishedAt: null,
  };
}

export function publish(post: Post, at: Date): Post {
  if (post.publishedAt) throw new Error(`post ${post.id} is already published`);
  return { ...post, publishedAt: at };
}
