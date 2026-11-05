import { authorHandle } from "./authors";
import type { Author, Post, Tag } from "./types";

export const SITE = "https://inkwell.blog";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function postUrl(post: Post): string {
  const date = post.publishedAt;
  if (!date) return `${SITE}/drafts/${post.id}`;
  return `${SITE}/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${post.slug}`;
}

export function tagUrl(tag: Tag): string {
  return `${SITE}/tags/${tag.slug}`;
}

export function authorUrl(author: Author): string {
  return `${SITE}/@${authorHandle(author)}`;
}
