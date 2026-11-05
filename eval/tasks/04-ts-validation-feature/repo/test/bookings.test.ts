import { describe, expect, test } from "bun:test";
import { BookingStore, overlaps, type BookingRequest } from "../src/bookings";
import { ConflictError } from "../src/errors";

function request(roomId: string, start: string, end: string): BookingRequest {
  return { roomId, start: new Date(start), end: new Date(end), attendees: 2, title: "Sync" };
}

describe("overlaps", () => {
  test("treats intervals as half-open", () => {
    const a = request("atlas", "2025-06-02T09:00:00Z", "2025-06-02T10:00:00Z");
    expect(overlaps(a, request("atlas", "2025-06-02T09:30:00Z", "2025-06-02T10:30:00Z"))).toBe(true);
    expect(overlaps(a, request("atlas", "2025-06-02T10:00:00Z", "2025-06-02T11:00:00Z"))).toBe(false);
    expect(overlaps(a, request("atlas", "2025-06-02T08:00:00Z", "2025-06-02T12:00:00Z"))).toBe(true);
  });
});

describe("BookingStore", () => {
  test("assigns ids and lists bookings per room in start order", () => {
    const store = new BookingStore();
    const late = store.add(request("atlas", "2025-06-02T14:00:00Z", "2025-06-02T15:00:00Z"));
    const early = store.add(request("atlas", "2025-06-02T09:00:00Z", "2025-06-02T10:00:00Z"));
    store.add(request("cove", "2025-06-02T09:00:00Z", "2025-06-02T10:00:00Z"));
    expect([late.id, early.id]).toEqual([1, 2]);
    expect(store.listForRoom("atlas").map((booking) => booking.id)).toEqual([2, 1]);
  });

  test("rejects overlapping bookings in the same room", () => {
    const store = new BookingStore();
    store.add(request("borealis", "2025-06-02T09:00:00Z", "2025-06-02T10:30:00Z"));
    expect(() => store.add(request("borealis", "2025-06-02T10:00:00Z", "2025-06-02T11:00:00Z"))).toThrow(
      new ConflictError("Borealis is already booked 2025-06-02 09:00-10:30 UTC"),
    );
  });

  test("cancel frees the slot", () => {
    const store = new BookingStore();
    const booking = store.add(request("cove", "2025-06-02T09:00:00Z", "2025-06-02T10:00:00Z"));
    expect(store.cancel(booking.id)).toBe(true);
    expect(store.cancel(booking.id)).toBe(false);
    expect(() => store.add(request("cove", "2025-06-02T09:00:00Z", "2025-06-02T10:00:00Z"))).not.toThrow();
  });
});
