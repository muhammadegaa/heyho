import type { Cart } from "./cart";
import { discountAmount, findDiscount } from "./discounts";
import { allocate, formatMoney, sumCents, type Cents } from "./money";
import { lineTax, taxRate } from "./tax";

export interface InvoiceLine {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: Cents;
  gross: Cents;
  discount: Cents;
  net: Cents;
  taxRate: number;
  tax: Cents;
}

export interface Invoice {
  region: string;
  lines: InvoiceLine[];
  subtotal: Cents;
  discountCode?: string;
  discount: Cents;
  tax: Cents;
  shipping: Cents;
  total: Cents;
}

export interface InvoiceOptions {
  region: string;
  discountCode?: string;
  shippingCents?: Cents;
}

export function buildInvoice(cart: Cart, options: InvoiceOptions): Invoice {
  if (cart.isEmpty) throw new Error("cannot invoice an empty cart");

  const cartLines = cart.lines;
  const grossAmounts = cartLines.map((line) => line.product.priceCents * line.quantity);
  const subtotal = sumCents(grossAmounts);

  let discount = 0;
  let discountCode: string | undefined;
  if (options.discountCode) {
    const found = findDiscount(options.discountCode);
    if (!found) throw new Error(`unknown discount code: ${options.discountCode}`);
    discount = discountAmount(found, subtotal);
    discountCode = found.code;
  }
  const lineDiscounts = discount > 0 ? allocate(discount, grossAmounts) : grossAmounts.map(() => 0);

  const lines = cartLines.map((line, i): InvoiceLine => {
    const net = grossAmounts[i] - lineDiscounts[i];
    const rate = taxRate(options.region, line.product.taxCategory);
    return {
      sku: line.product.sku,
      name: line.product.name,
      quantity: line.quantity,
      unitPrice: line.product.priceCents,
      gross: grossAmounts[i],
      discount: lineDiscounts[i],
      net,
      taxRate: rate,
      tax: lineTax(net, rate),
    };
  });

  const tax = sumCents(lines.map((line) => line.tax));
  const shipping = options.shippingCents ?? 0;
  const invoice: Invoice = {
    region: options.region,
    lines,
    subtotal,
    discountCode,
    discount,
    tax,
    shipping,
    total: subtotal - discount + tax + shipping,
  };
  assertBalanced(invoice);
  return invoice;
}

function assertBalanced(invoice: Invoice): void {
  const expected = invoice.subtotal - invoice.discount;
  const lineNet = sumCents(invoice.lines.map((line) => line.net));
  if (lineNet !== expected) {
    throw new Error(`invoice does not balance: line nets add up to ${lineNet}, expected ${expected}`);
  }
  if (invoice.lines.some((line) => line.net < 0)) {
    throw new Error("invoice has a line with a negative net amount");
  }
}

export function renderInvoice(invoice: Invoice, currency = "GBP"): string {
  const money = (cents: Cents) => formatMoney(cents, currency).padStart(10);
  const rows = invoice.lines.map(
    (line) => `${String(line.quantity).padStart(3)} x ${line.name.padEnd(28)}${money(line.net)}`,
  );
  rows.push(`${"Subtotal".padEnd(34)}${money(invoice.subtotal)}`);
  if (invoice.discount > 0) {
    rows.push(`${`Discount (${invoice.discountCode})`.padEnd(34)}${money(-invoice.discount)}`);
  }
  rows.push(`${"VAT".padEnd(34)}${money(invoice.tax)}`);
  if (invoice.shipping > 0) rows.push(`${"Shipping".padEnd(34)}${money(invoice.shipping)}`);
  rows.push(`${"Total".padEnd(34)}${money(invoice.total)}`);
  return rows.join("\n");
}
