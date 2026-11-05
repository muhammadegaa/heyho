export const MINUTE_MS = 60_000;

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse an ISO 8601 timestamp that carries a timezone, such as
 * "2025-06-02T09:00:00Z" or "2025-06-02T11:00:00+02:00".
 * Returns null for anything else, including impossible dates like Feb 30.
 */
export function parseInstant(text: string): Date | null {
  const match = INSTANT.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", ms = "0", zone] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRest = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetRest > 59) return null;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetRest);
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, Number(ms.padEnd(3, "0")));
  return new Date(utc - offsetMinutes * MINUTE_MS);
}

export function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MINUTE_MS;
}

/** True when the instant falls exactly on a multiple of `minutes` (in UTC). */
export function isAligned(instant: Date, minutes: number): boolean {
  return instant.getTime() % (minutes * MINUTE_MS) === 0;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "2025-06-02 09:00-10:30 UTC" */
export function formatSlot(start: Date, end: Date): string {
  const date = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
  const clock = (instant: Date) => `${pad(instant.getUTCHours())}:${pad(instant.getUTCMinutes())}`;
  return `${date} ${clock(start)}-${clock(end)} UTC`;
}
