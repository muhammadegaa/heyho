import { getProduct, type Product } from "./catalog";
import { sumCents, type Cents } from "./money";

export interface CartLine {
  product: Product;
  quantity: number;
}

export class Cart {
  private readonly items = new Map<string, CartLine>();

  add(sku: string, quantity = 1): void {
    assertQuantity(quantity);
    const existing = this.items.get(sku);
    if (existing) {
      existing.quantity += quantity;
    } else {
      this.items.set(sku, { product: getProduct(sku), quantity });
    }
  }

  setQuantity(sku: string, quantity: number): void {
    if (quantity === 0) {
      this.items.delete(sku);
      return;
    }
    assertQuantity(quantity);
    const line = this.items.get(sku);
    if (!line) throw new Error(`not in cart: ${sku}`);
    line.quantity = quantity;
  }

  remove(sku: string): void {
    this.items.delete(sku);
  }

  get lines(): CartLine[] {
    return [...this.items.values()].map((line) => ({ ...line }));
  }

  get isEmpty(): boolean {
    return this.items.size === 0;
  }

  get subtotal(): Cents {
    return sumCents(this.lines.map((line) => line.product.priceCents * line.quantity));
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`quantity must be a positive whole number, got ${quantity}`);
  }
}
