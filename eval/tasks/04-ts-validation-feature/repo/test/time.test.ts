import { describe, expect, test } from "bun:test";
import { formatSlot, isAligned, minutesBetween, parseInstant } from "../src/time";

describe("parseInstant", () => {
  test("accepts Z and numeric offsets", () => {
    expect(parseInstant("2025-06-02T09:00:00Z")?.toISOString()).toBe("2025-06-02T09:00:00.000Z");
    expect(parseInstant("2025-06-02T11:00:00+02:00")?.toISOString()).toBe("2025-06-02T09:00:00.000Z");
    expect(parseInstant("2025-06-02T05:30:00-03:30")?.toISOString()).toBe("2025-06-02T09:00:00.000Z");
    expect(parseInstant("2025-06-02T09:00:00.25Z")?.toISOString()).toBe("2025-06-02T09:00:00.250Z");
  });

  test("rejects timestamps without a timezone and impossible dates", () => {
    for (const text of [
      "2025-06-02T09:00:00",
      "2025-06-02",
      "2025-02-29T09:00:00Z",
      "2025-06-02T24:00:00Z",
      "2025-06-02T09:00:00+15:00",
      "June 2nd",
      "",
    ]) {
      expect(parseInstant(text)).toBeNull();
    }
    expect(parseInstant("2024-02-29T09:00:00Z")).not.toBeNull();
  });
});

describe("helpers", () => {
  test("minutesBetween and isAligned", () => {
    const start = parseInstant("2025-06-02T09:15:00Z")!;
    const end = parseInstant("2025-06-02T10:45:00Z")!;
    expect(minutesBetween(start, end)).toBe(90);
    expect(isAligned(start, 15)).toBe(true);
    expect(isAligned(start, 30)).toBe(false);
    expect(isAligned(parseInstant("2025-06-02T09:15:01Z")!, 15)).toBe(false);
  });

  test("formatSlot", () => {
    const start = parseInstant("2025-06-02T09:00:00Z")!;
    const end = parseInstant("2025-06-02T10:30:00Z")!;
    expect(formatSlot(start, end)).toBe("2025-06-02 09:00-10:30 UTC");
  });
});
