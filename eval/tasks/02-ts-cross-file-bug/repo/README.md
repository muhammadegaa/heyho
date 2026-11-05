# teashop-checkout

Cart and invoice logic for the tea shop. All amounts are integer cents.

- `src/catalog.ts` products and their tax categories
- `src/cart.ts` the shopping cart
- `src/discounts.ts` discount codes
- `src/tax.ts` VAT rates per region
- `src/money.ts` parsing, formatting and splitting money amounts
- `src/invoice.ts` turns a cart into an invoice; an order-level discount is
  spread over the lines in proportion to their value, and every invoice is
  checked to balance before it is returned

```
bun test
```
