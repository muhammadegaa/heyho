import { describe, expect, test } from "bun:test";
import { Cart } from "../src/cart";
import { buildInvoice } from "../src/invoice";
import { allocate, sumCents } from "../src/money";

function largestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  const leftover = total - shares.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, r: (total * w) % sum }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < leftover; k++) shares[order[k].i] += 1;
  return shares;
}

function* cases(): Generator<[number, number[]]> {
  let seed = 12345;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let c = 0; c < 400; c++) {
    const count = 1 + next(7);
    const weights = Array.from({ length: count }, () => (next(4) === 0 ? 0 : 1 + next(25)));
    if (weights.every((w) => w === 0)) weights[next(count)] = 1 + next(5);
    yield [next(2000), weights];
  }
}

describe("allocate contract", () => {
  test("rounding up would overshoot: shares still add up to the total", () => {
    expect(allocate(500, [1000, 1000, 1000])).toEqual([167, 167, 166]);
    expect(allocate(10, [1, 1, 1, 1])).toEqual([3, 3, 2, 2]);
    expect(allocate(5, [1, 1, 1])).toEqual([2, 2, 1]);
  });

  test("spare cents go to the largest fractional parts, not to the first or last shares", () => {
    expect(allocate(3, [2, 1, 1])).toEqual([1, 1, 1]);
    expect(allocate(11, [1, 2, 2])).toEqual([2, 5, 4]);
    expect(allocate(7, [3, 1])).toEqual([5, 2]);
    expect(allocate(1942, [9998, 1000, 1950])).toEqual([1500, 150, 292]);
  });

  test("ties go to the earlier share", () => {
    expect(allocate(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocate(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  test("zero weights always get zero", () => {
    expect(allocate(4, [0, 1, 1, 1])).toEqual([0, 2, 1, 1]);
    expect(allocate(5, [0, 1, 1])).toEqual([0, 3, 2]);
    expect(allocate(2, [1, 0, 1])).toEqual([1, 0, 1]);
    expect(allocate(9, [0, 0, 3])).toEqual([0, 0, 9]);
  });

  test("generated cases follow the largest-remainder rule", () => {
    for (const [total, weights] of cases()) {
      const shares = allocate(total, weights);
      expect(sumCents(shares)).toBe(total);
      expect(shares).toEqual(largestRemainder(total, weights));
    }
  });

  test("does not modify its input and still validates it", () => {
    const weights = [3, 1, 1];
    allocate(10, weights);
    expect(weights).toEqual([3, 1, 1]);
    expect(() => allocate(10, [0, 0])).toThrow(RangeError);
    expect(() => allocate(10, [2, -1])).toThrow(RangeError);
    expect(() => allocate(-1, [1])).toThrow(RangeError);
    expect(() => allocate(0.5, [1])).toThrow(RangeError);
  });
});

describe("invoices with spread discounts", () => {
  function cartWith(...items: [string, number][]): Cart {
    const cart = new Cart();
    for (const [sku, quantity] of items) cart.add(sku, quantity);
    return cart;
  }

  test("three equal lines with a fixed discount", () => {
    const invoice = buildInvoice(cartWith(["BAG-03", 1], ["MUG-01", 1], ["TEA-02", 1]), {
      region: "de",
      discountCode: "WELCOME5",
      shippingCents: 395,
    });
    expect(invoice.lines.map((line) => line.discount)).toEqual([167, 167, 166]);
    expect(invoice.lines.map((line) => line.net)).toEqual([833, 833, 834]);
    expect(invoice.tax).toBe(158 + 158 + 58);
    expect(invoice.total).toBe(2500 + 374 + 395);
  });

  test("percentage discount across mixed lines", () => {
    const invoice = buildInvoice(cartWith(["KETTLE-05", 2], ["TEA-02", 1], ["TIN-06", 3]), {
      region: "de",
      discountCode: "BIGSPEND",
    });
    expect(invoice.discount).toBe(1942);
    expect(invoice.lines.map((line) => line.discount)).toEqual([1500, 150, 292]);
    expect(invoice.lines.map((line) => line.net)).toEqual([8498, 850, 1658]);
    expect(invoice.tax).toBe(1990);
    expect(invoice.total).toBe(12996);
  });

  test("line discounts always add up to the order discount", () => {
    const skus = ["MUG-01", "TEA-02", "BAG-03", "BOOK-04", "KETTLE-05", "TIN-06"];
    for (let n = 1; n <= skus.length; n++) {
      for (const code of ["WELCOME5", "TEN"]) {
        const cart = cartWith(...skus.slice(0, n).map((sku, i): [string, number] => [sku, 1 + (i % 3)]));
        const invoice = buildInvoice(cart, { region: "nl", discountCode: code });
        expect(sumCents(invoice.lines.map((line) => line.discount))).toBe(invoice.discount);
        expect(sumCents(invoice.lines.map((line) => line.net))).toBe(invoice.subtotal - invoice.discount);
      }
    }
  });
});
