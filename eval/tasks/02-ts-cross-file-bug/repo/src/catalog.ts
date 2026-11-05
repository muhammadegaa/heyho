import type { Cents } from "./money";

export type TaxCategory = "standard" | "reduced" | "exempt";

export interface Product {
  sku: string;
  name: string;
  priceCents: Cents;
  taxCategory: TaxCategory;
}

const PRODUCTS: readonly Product[] = [
  { sku: "MUG-01", name: "Enamel mug", priceCents: 1000, taxCategory: "standard" },
  { sku: "TEA-02", name: "Loose leaf tea, 100 g", priceCents: 1000, taxCategory: "reduced" },
  { sku: "BAG-03", name: "Canvas tote", priceCents: 1000, taxCategory: "standard" },
  { sku: "BOOK-04", name: "Brewing guide (paperback)", priceCents: 1499, taxCategory: "exempt" },
  { sku: "KETTLE-05", name: "Gooseneck kettle", priceCents: 4999, taxCategory: "standard" },
  { sku: "TIN-06", name: "Storage tin", priceCents: 650, taxCategory: "standard" },
];

export function findProduct(sku: string): Product | undefined {
  return PRODUCTS.find((product) => product.sku === sku);
}

export function getProduct(sku: string): Product {
  const product = findProduct(sku);
  if (!product) throw new Error(`unknown product: ${sku}`);
  return product;
}

export function allProducts(): readonly Product[] {
  return PRODUCTS;
}
