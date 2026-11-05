import { percentOf, type Cents } from "./money";

export type Discount =
  | { code: string; kind: "percent"; percent: number; minSubtotal?: Cents }
  | { code: string; kind: "fixed"; amountCents: Cents; minSubtotal?: Cents };

const DISCOUNTS: readonly Discount[] = [
  { code: "WELCOME5", kind: "fixed", amountCents: 500, minSubtotal: 2000 },
  { code: "TEN", kind: "percent", percent: 10 },
  { code: "BIGSPEND", kind: "percent", percent: 15, minSubtotal: 10000 },
];

export function findDiscount(code: string): Discount | undefined {
  const wanted = code.trim().toUpperCase();
  return DISCOUNTS.find((discount) => discount.code === wanted);
}

/** How much a discount takes off a subtotal; never more than the subtotal itself. */
export function discountAmount(discount: Discount, subtotal: Cents): Cents {
  if (discount.minSubtotal !== undefined && subtotal < discount.minSubtotal) return 0;
  const amount = discount.kind === "percent" ? percentOf(subtotal, discount.percent) : discount.amountCents;
  return Math.min(amount, subtotal);
}
