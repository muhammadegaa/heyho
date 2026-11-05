import { describe, expect, test } from "bun:test";
import { normalizeTags, tagSlug } from "../src/tags";

describe("tags", () => {
  test("tagSlug", () => {
    expect(tagSlug("Machine Learning")).toBe("machine-learning");
    expect(tagSlug("R&D")).toBe("r-and-d");
    expect(tagSlug("Ästhetik")).toBe("asthetik");
  });

  test("tagSlug rejects names without letters or digits", () => {
    expect(() => tagSlug("???")).toThrow('tag "???" has no letters or digits');
  });

  test("normalizeTags keeps the first spelling and skips blanks", () => {
    expect(normalizeTags(["Type Script", "  type   script ", "", "Bun"])).toEqual([
      { slug: "type-script", name: "Type Script" },
      { slug: "bun", name: "Bun" },
    ]);
  });
});
