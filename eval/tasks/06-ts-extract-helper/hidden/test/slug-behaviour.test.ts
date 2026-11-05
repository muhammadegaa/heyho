import { describe, expect, test } from "bun:test";
import { authorHandle, byline } from "../src/authors";
import { createPost, postSlug } from "../src/posts";
import { normalizeTags, tagSlug } from "../src/tags";
import { authorUrl, tagUrl } from "../src/urls";

// [input, postSlug(input), tagSlug(input) or null when it throws, authorHandle for displayName = input]
const CASES: [string, string, string | null, string][] = [
  ["Hello, World!", "hello-world", "hello-world", "hello-world"],
  ["Crème Brûlée & Café", "creme-brulee-and-cafe", "creme-brulee-and-cafe", "creme-brulee-and-cafe"],
  ["Don’t Panic", "dont-panic", "dont-panic", "dont-panic"],
  ["  --Leading and trailing--  ", "leading-and-trailing", "leading-and-trailing", "leading-and-trailing"],
  ["ﬁnal ﬂight", "final-flight", "final-flight", "final-flight"],
  ["Ünïcödé Ünïcórn", "unicode-unicorn", "unicode-unicorn", "unicode-unicorn"],
  ["C++ & Rust: a love story", "c-and-rust-a-love-story", "c-and-rust-a-love-story", "c-and-rust-a-love-story"],
  ["Straße", "stra-e", "stra-e", "stra-e"],
  ["100% Pure", "100-pure", "100-pure", "100-pure"],
  ["x² + y²", "x2-y2", "x2-y2", "x2-y2"],
  ["Ⅻ Roman Numerals", "xii-roman-numerals", "xii-roman-numerals", "xii-roman-numerals"],
  ["İstanbul’da Kış", "istanbulda-k-s", "istanbulda-k-s", "istanbulda-k-s"],
  ["Rock'n'Roll", "rocknroll", "rocknroll", "rocknroll"],
  ["tabs\tand\nnewlines", "tabs-and-newlines", "tabs-and-newlines", "tabs-and-newlines"],
  ["___under___scores___", "under-scores", "under-scores", "under-scores"],
  ["a-b--c---d", "a-b-c-d", "a-b-c-d", "a-b-c-d"],
  ["The Quick Brown Fox Jumps Over The Lazy Dog And Keeps Running Far Away", "the-quick-brown-fox-jumps-over-the-lazy-dog-and-keeps-runnin", "the-quick-brown-fox-jumps-over-t", "the-quick-brown-fox-jumps-over-the-lazy"],
  ["Ninety-nine bottles of beer on the wall, ninety-nine bottles of beer, take one down", "ninety-nine-bottles-of-beer-on-the-wall-ninety-nine-bottles", "ninety-nine-bottles-of-beer-on-t", "ninety-nine-bottles-of-beer-on-the-wall"],
  ["Supercalifragilisticexpialidocious-and-antidisestablishmentarianism-x", "supercalifragilisticexpialidocious-and-antidisestablishmenta", "supercalifragilisticexpialidocio", "supercalifragilisticexpialidocious-and-a"],
  ["An extremely long tag name that goes on", "an-extremely-long-tag-name-that-goes-on", "an-extremely-long-tag-name-that", "an-extremely-long-tag-name-that-goes-on"],
  ["Tag name with exactly thirty-two!", "tag-name-with-exactly-thirty-two", "tag-name-with-exactly-thirty-two", "tag-name-with-exactly-thirty-two"],
  ["abcdefghijklmnopqrstuvwxyz abcdefg hij", "abcdefghijklmnopqrstuvwxyz-abcdefg-hij", "abcdefghijklmnopqrstuvwxyz-abcde", "abcdefghijklmnopqrstuvwxyz-abcdefg-hij"],
  ["1234567890123456789012345678901 2", "1234567890123456789012345678901-2", "1234567890123456789012345678901", "1234567890123456789012345678901-2"],
  ["日本語のタイトル", "untitled", null, "user-9"],
  ["🚀🚀🚀", "untitled", null, "user-9"],
  ["", "untitled", null, "fallback-name-x"],
];

describe("slug behaviour is unchanged", () => {
  test("postSlug (max 60, falls back to untitled)", () => {
    for (const [input, post] of CASES) expect([input, postSlug(input)]).toEqual([input, post]);
  });

  test("tagSlug (max 32, throws when nothing is left)", () => {
    for (const [input, , tag] of CASES) {
      if (tag === null) {
        expect(() => tagSlug(input)).toThrow(`tag "${input}" has no letters or digits`);
      } else {
        expect([input, tagSlug(input)]).toEqual([input, tag]);
      }
    }
  });

  test("authorHandle (max 40, falls back to the email name, then user-<id>)", () => {
    for (const [input, , , handle] of CASES) {
      const author = { id: 9, displayName: input, email: "fallback.name+x@example.com" };
      expect([input, authorHandle(author)]).toEqual([input, handle]);
    }
  });

  test("unique post slugs keep counting after truncation", () => {
    const long = "The Quick Brown Fox Jumps Over The Lazy Dog And Keeps Running Far Away";
    const base = "the-quick-brown-fox-jumps-over-the-lazy-dog-and-keeps-runnin";
    expect(postSlug(long, new Set([base]))).toBe(`${base}-2`);
    expect(postSlug("!!!", new Set(["untitled", "untitled-2"]))).toBe("untitled-3");
  });

  test("callers still use the same rules", () => {
    const post = createPost(
      { title: "Crème Brûlée & Café", body: "", authorId: 1, tags: ["Ästhetik", "asthetik", "An extremely long tag name that goes on"] },
      [],
    );
    expect(post.slug).toBe("creme-brulee-and-cafe");
    expect(post.tags).toEqual([
      { slug: "asthetik", name: "Ästhetik" },
      { slug: "an-extremely-long-tag-name-that", name: "An extremely long tag name that goes on" },
    ]);
    expect(() => normalizeTags(["ok", "🚀"])).toThrow('tag "🚀" has no letters or digits');
    expect(tagUrl({ slug: tagSlug("R&D"), name: "R&D" })).toBe("https://inkwell.blog/tags/r-and-d");
    const author = { id: 5, displayName: "Zoë O’Connor-Smith", email: "zoe@example.com" };
    expect(byline(author)).toBe("Zoë O’Connor-Smith (@zoe-oconnor-smith)");
    expect(authorUrl(author)).toBe("https://inkwell.blog/@zoe-oconnor-smith");
  });
});
