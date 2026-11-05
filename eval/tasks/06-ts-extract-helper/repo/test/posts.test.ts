import { describe, expect, test } from "bun:test";
import { createPost, excerpt, postSlug, publish } from "../src/posts";

describe("postSlug", () => {
  test("basic titles", () => {
    expect(postSlug("Hello, World!")).toBe("hello-world");
    expect(postSlug("Crème Brûlée & Café")).toBe("creme-brulee-and-cafe");
    expect(postSlug("Don't Panic")).toBe("dont-panic");
  });

  test("falls back to untitled", () => {
    expect(postSlug("!!!")).toBe("untitled");
  });

  test("makes slugs unique", () => {
    expect(postSlug("Hello", new Set(["hello", "hello-2"]))).toBe("hello-3");
  });
});

describe("posts", () => {
  test("createPost fills in id, slug and tags", () => {
    const first = createPost({ title: " Launch day ", body: "We shipped.", authorId: 1, tags: ["News", "news "] }, []);
    const second = createPost({ title: "Launch Day!", body: "Again.", authorId: 1 }, [first]);
    expect(first).toMatchObject({ id: 1, title: "Launch day", slug: "launch-day", publishedAt: null });
    expect(first.tags).toEqual([{ slug: "news", name: "News" }]);
    expect(second).toMatchObject({ id: 2, slug: "launch-day-2" });
    expect(() => createPost({ title: "  ", body: "", authorId: 1 }, [])).toThrow("a post needs a title");
  });

  test("publish", () => {
    const post = createPost({ title: "Notes", body: "", authorId: 2 }, []);
    const at = new Date("2025-03-04T10:00:00Z");
    expect(publish(post, at).publishedAt).toBe(at);
    expect(() => publish(publish(post, at), at)).toThrow("post 1 is already published");
  });

  test("excerpt", () => {
    expect(excerpt("# Title\n\nSome *bold* text", 10)).toBe("Title Some bold text");
    expect(excerpt("one two three four", 2)).toBe("one two…");
  });
});
