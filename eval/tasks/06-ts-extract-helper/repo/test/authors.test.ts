import { describe, expect, test } from "bun:test";
import { authorHandle, byline } from "../src/authors";
import { authorUrl, postUrl, tagUrl } from "../src/urls";
import { createPost, publish } from "../src/posts";

describe("authors", () => {
  test("handle from display name or email", () => {
    expect(authorHandle({ id: 1, displayName: "José Álvarez", email: "jose@example.com" })).toBe("jose-alvarez");
    expect(authorHandle({ id: 2, displayName: " ", email: "sam.lee@example.com" })).toBe("sam-lee");
    expect(authorHandle({ id: 3, displayName: "李雷", email: "x@example.com" })).toBe("user-3");
  });

  test("byline", () => {
    expect(byline({ id: 4, displayName: "O'Brien", email: "ob@example.com" })).toBe("O'Brien (@obrien)");
  });
});

describe("urls", () => {
  test("post, tag and author urls", () => {
    const draft = createPost({ title: "Draft ideas", body: "", authorId: 1 }, []);
    expect(postUrl(draft)).toBe("https://inkwell.blog/drafts/1");
    expect(postUrl(publish(draft, new Date("2025-03-04T10:00:00Z")))).toBe("https://inkwell.blog/2025/03/draft-ideas");
    expect(tagUrl({ slug: "bun", name: "Bun" })).toBe("https://inkwell.blog/tags/bun");
    expect(authorUrl({ id: 1, displayName: "Ada", email: "ada@example.com" })).toBe("https://inkwell.blog/@ada");
  });
});
