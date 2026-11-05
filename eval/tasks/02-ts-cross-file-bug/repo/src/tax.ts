import type { TaxCategory } from "./catalog";
import { percentOf, type Cents } from "./money";

const RATES: Record<string, Record<TaxCategory, number>> = {
  uk: { standard: 20, reduced: 5, exempt: 0 },
  de: { standard: 19, reduced: 7, exempt: 0 },
  nl: { standard: 21, reduced: 9, exempt: 0 },
};

export function supportedRegions(): string[] {
  return Object.keys(RATES);
}

export function taxRate(region: string, category: TaxCategory): number {
  const rates = RATES[region.toLowerCase()];
  if (!rates) throw new Error(`no tax rates for region: ${region}`);
  return rates[category];
}

/** VAT on a net amount, rounded half up per line. */
export function lineTax(netCents: Cents, ratePercent: number): Cents {
  return percentOf(netCents, ratePercent);
}
