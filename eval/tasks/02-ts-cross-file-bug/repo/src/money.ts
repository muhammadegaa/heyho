export type Cents = number;

const AMOUNT = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

const SYMBOLS: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };

/** Parse a decimal amount such as "12.5" or 0.99 into integer cents. */
export function toCents(amount: string | number): Cents {
  const text = typeof amount === "number" ? amount.toFixed(2) : amount.trim();
  const match = AMOUNT.exec(text);
  if (!match) throw new RangeError(`not a money amount: ${amount}`);
  const [, minus, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return minus ? -cents : cents;
}

export function formatMoney(cents: Cents, currency = "GBP"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = String(abs % 100).padStart(2, "0");
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${sign}${symbol}${whole}.${fraction}`;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, value) => total + value, 0);
}

/** `percent`% of an amount, rounded half up to the nearest cent. */
export function percentOf(cents: Cents, percent: number): Cents {
  return Math.round((cents * percent) / 100);
}

/**
 * Split `totalCents` into whole-cent shares proportional to `weights`.
 *
 * The shares always add up to exactly `totalCents`. Cents that cannot be
 * split evenly go to the shares with the largest fractional parts, earlier
 * shares first on ties, so a share with weight 0 always gets 0.
 */
export function allocate(totalCents: Cents, weights: readonly number[]): Cents[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError(`allocate: total must be a non-negative whole number of cents, got ${totalCents}`);
  }
  if (weights.some((weight) => weight < 0)) {
    throw new RangeError("allocate: weights must not be negative");
  }
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) {
    throw new RangeError("allocate: weights must add up to more than zero");
  }

  const shares = weights.map((weight) => Math.round((totalCents * weight) / weightSum));
  let leftover = totalCents - sumCents(shares);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length) {
    shares[i] += 1;
    leftover -= 1;
  }
  return shares;
}
