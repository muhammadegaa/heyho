import { describe, expect, test } from "bun:test";
import { Cart } from "../src/cart";
import { buildInvoice, renderInvoice } from "../src/invoice";

function cartWith(...items: [string, number][]): Cart {
  const cart = new Cart();
  for (const [sku, quantity] of items) cart.add(sku, quantity);
  return cart;
}

describe("buildInvoice", () => {
  test("invoice without a discount", () => {
    const invoice = buildInvoice(cartWith(["MUG-01", 2], ["BOOK-04", 1]), { region: "uk", shippingCents: 395 });
    expect(invoice.subtotal).toBe(3499);
    expect(invoice.discount).toBe(0);
    expect(invoice.lines.map((line) => line.tax)).toEqual([400, 0]);
    expect(invoice.total).toBe(3499 + 400 + 395);
  });

  test("percentage discount on a single line", () => {
    const invoice = buildInvoice(cartWith(["KETTLE-05", 2]), { region: "uk", discountCode: "ten" });
    expect(invoice.discountCode).toBe("TEN");
    expect(invoice.discount).toBe(1000);
    expect(invoice.lines[0].net).toBe(8998);
    expect(invoice.tax).toBe(1800);
    expect(invoice.total).toBe(10798);
  });

  test("spreads a fixed discount over equally priced lines", () => {
    const invoice = buildInvoice(cartWith(["MUG-01", 1], ["TEA-02", 1], ["BAG-03", 1]), {
      region: "uk",
      discountCode: "WELCOME5",
    });
    expect(invoice.discount).toBe(500);
    expect(invoice.lines.map((line) => line.discount)).toEqual([167, 167, 166]);
    expect(invoice.lines.map((line) => line.net)).toEqual([833, 833, 834]);
    expect(invoice.tax).toBe(167 + 42 + 167);
    expect(invoice.total).toBe(3000 - 500 + 376);
  });

  test("discount below its minimum subtotal does nothing", () => {
    const invoice = buildInvoice(cartWith(["TIN-06", 1]), { region: "de", discountCode: "WELCOME5" });
    expect(invoice.discount).toBe(0);
    expect(invoice.total).toBe(650 + 124);
  });

  test("rejects unknown codes, regions and empty carts", () => {
    expect(() => buildInvoice(cartWith(["MUG-01", 1]), { region: "uk", discountCode: "FREE" })).toThrow(
      "unknown discount code: FREE",
    );
    expect(() => buildInvoice(cartWith(["MUG-01", 1]), { region: "fr" })).toThrow("no tax rates for region: fr");
    expect(() => buildInvoice(new Cart(), { region: "uk" })).toThrow("cannot invoice an empty cart");
  });
});

describe("renderInvoice", () => {
  test("lists lines and totals", () => {
    const text = renderInvoice(buildInvoice(cartWith(["TIN-06", 2]), { region: "nl", shippingCents: 250 }));
    expect(text.split("\n")).toEqual([
      "  2 x Storage tin                     £13.00",
      "Subtotal                              £13.00",
      "VAT                                    £2.73",
      "Shipping                               £2.50",
      "Total                                 £18.23",
    ]);
  });
});
