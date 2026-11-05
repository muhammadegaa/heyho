import { describe, expect, test } from "bun:test";
import { allocate, formatMoney, percentOf, sumCents, toCents } from "../src/money";

describe("toCents", () => {
  test("parses decimal strings and numbers", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents("12.5")).toBe(1250);
    expect(toCents("7")).toBe(700);
    expect(toCents(" -0.99 ")).toBe(-99);
    expect(toCents(19.99)).toBe(1999);
  });

  test("rejects anything else", () => {
    expect(() => toCents("12.345")).toThrow(RangeError);
    expect(() => toCents("£5")).toThrow(RangeError);
    expect(() => toCents("")).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  test("formats with symbol and thousands separators", () => {
    expect(formatMoney(123456789)).toBe("£1,234,567.89");
    expect(formatMoney(5, "EUR")).toBe("€0.05");
    expect(formatMoney(-1250, "USD")).toBe("-$12.50");
    expect(formatMoney(100, "CHF")).toBe("CHF 1.00");
  });
});

describe("percentOf", () => {
  test("rounds half up", () => {
    expect(percentOf(1999, 15)).toBe(300);
    expect(percentOf(1050, 10)).toBe(105);
    expect(percentOf(833, 20)).toBe(167);
  });
});

describe("allocate", () => {
  test("splits evenly divisible amounts exactly", () => {
    expect(allocate(1000, [1, 3])).toEqual([250, 750]);
    expect(allocate(600, [200, 200, 200])).toEqual([200, 200, 200]);
  });

  test("gives the spare cent to the first share on a tie", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  test("allocating nothing gives zeros", () => {
    expect(allocate(0, [5, 7])).toEqual([0, 0]);
  });

  test("shares add up to the total", () => {
    const shares = allocate(1999, [1999, 4999, 650]);
    expect(sumCents(shares)).toBe(1999);
  });

  test("rejects bad input", () => {
    expect(() => allocate(10, [0, 0])).toThrow(RangeError);
    expect(() => allocate(10, [1, -1])).toThrow(RangeError);
    expect(() => allocate(-5, [1])).toThrow(RangeError);
    expect(() => allocate(2.5, [1])).toThrow(RangeError);
  });
});
