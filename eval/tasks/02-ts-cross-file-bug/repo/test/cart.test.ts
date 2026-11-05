import { describe, expect, test } from "bun:test";
import { Cart } from "../src/cart";

describe("Cart", () => {
  test("adds products and merges repeated adds", () => {
    const cart = new Cart();
    cart.add("MUG-01");
    cart.add("TEA-02", 2);
    cart.add("MUG-01", 2);
    expect(cart.lines.map((line) => [line.product.sku, line.quantity])).toEqual([
      ["MUG-01", 3],
      ["TEA-02", 2],
    ]);
    expect(cart.subtotal).toBe(5000);
  });

  test("setQuantity changes or removes a line", () => {
    const cart = new Cart();
    cart.add("BOOK-04");
    cart.add("TIN-06");
    cart.setQuantity("BOOK-04", 4);
    cart.setQuantity("TIN-06", 0);
    expect(cart.lines).toHaveLength(1);
    expect(cart.subtotal).toBe(5996);
  });

  test("lines are copies", () => {
    const cart = new Cart();
    cart.add("MUG-01");
    cart.lines[0].quantity = 99;
    expect(cart.lines[0].quantity).toBe(1);
  });

  test("rejects unknown products and bad quantities", () => {
    const cart = new Cart();
    expect(() => cart.add("NOPE")).toThrow("unknown product: NOPE");
    expect(() => cart.add("MUG-01", 0)).toThrow(RangeError);
    expect(() => cart.add("MUG-01", 1.5)).toThrow(RangeError);
    expect(() => cart.setQuantity("MUG-01", 2)).toThrow("not in cart: MUG-01");
  });
});
