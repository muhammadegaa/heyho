import { describe, expect, test } from "bun:test";
import { BookingStore, parseBookingRequest } from "../src/bookings";
import { ValidationError } from "../src/errors";

const valid = {
  roomId: "atlas",
  start: "2025-06-02T09:00:00Z",
  end: "2025-06-02T10:30:00Z",
  attendees: 3,
  title: "  Sprint planning  ",
};

function rejects(input: unknown, field: string, message: string): void {
  let caught: unknown;
  try {
    parseBookingRequest(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect({ field: (caught as ValidationError).field, message: (caught as ValidationError).message }).toEqual({
    field,
    message,
  });
}

describe("parseBookingRequest: valid input", () => {
  test("returns a BookingRequest with Dates and a trimmed title", () => {
    const result = parseBookingRequest(valid);
    expect(result).toEqual({
      roomId: "atlas",
      start: new Date("2025-06-02T09:00:00Z"),
      end: new Date("2025-06-02T10:30:00Z"),
      attendees: 3,
      title: "Sprint planning",
    });
    expect(result.start).toBeInstanceOf(Date);
    expect(Object.keys(result).sort()).toEqual(["attendees", "end", "roomId", "start", "title"]);
  });

  test("accepts numeric offsets", () => {
    const result = parseBookingRequest({ ...valid, start: "2025-06-02T11:00:00+02:00", end: "2025-06-02T16:15:00+05:45" });
    expect(result.start.toISOString()).toBe("2025-06-02T09:00:00.000Z");
    expect(result.end.toISOString()).toBe("2025-06-02T10:30:00.000Z");
  });

  test("missing or blank title becomes the default", () => {
    const { title: _omit, ...withoutTitle } = valid;
    expect(parseBookingRequest(withoutTitle).title).toBe("Untitled booking");
    expect(parseBookingRequest({ ...valid, title: "   " }).title).toBe("Untitled booking");
    expect(parseBookingRequest({ ...valid, title: "" }).title).toBe("Untitled booking");
  });

  test("limits are inclusive", () => {
    expect(parseBookingRequest({ ...valid, title: ` ${"x".repeat(80)} ` }).title).toBe("x".repeat(80));
    expect(parseBookingRequest({ ...valid, attendees: 4 }).attendees).toBe(4);
    expect(parseBookingRequest({ ...valid, roomId: "cove", attendees: 2 }).roomId).toBe("cove");
    expect(parseBookingRequest({ ...valid, end: "2025-06-02T13:00:00Z" }).end.toISOString()).toBe(
      "2025-06-02T13:00:00.000Z",
    );
    expect(parseBookingRequest({ ...valid, end: "2025-06-02T09:15:00Z" }).end.toISOString()).toBe(
      "2025-06-02T09:15:00.000Z",
    );
    expect(parseBookingRequest({ ...valid, start: "2025-06-02T09:45:00.000Z" }).start.toISOString()).toBe(
      "2025-06-02T09:45:00.000Z",
    );
  });

  test("does not modify the input and feeds the store", () => {
    const input = { ...valid };
    const store = new BookingStore();
    const booking = store.add(parseBookingRequest(input));
    expect(input).toEqual(valid);
    expect(booking.title).toBe("Sprint planning");
  });
});

describe("parseBookingRequest: errors", () => {
  test("rule 1: not a plain object", () => {
    for (const input of [null, undefined, [], [valid], "atlas", 42, true]) {
      rejects(input, "request", "request must be an object");
    }
  });

  test("rule 2: unexpected fields", () => {
    rejects({ ...valid, notes: "bring snacks" }, "notes", "unexpected field: notes");
    rejects({ room: "atlas", ...valid }, "room", "unexpected field: room");
  });

  test("rule 3: roomId required", () => {
    const { roomId: _omit, ...withoutRoom } = valid;
    rejects(withoutRoom, "roomId", "roomId is required");
    rejects({ ...valid, roomId: "" }, "roomId", "roomId is required");
    rejects({ ...valid, roomId: 7 }, "roomId", "roomId is required");
    rejects({ ...valid, roomId: null }, "roomId", "roomId is required");
  });

  test("rule 4: unknown room", () => {
    rejects({ ...valid, roomId: "zephyr" }, "roomId", "unknown room: zephyr");
    rejects({ ...valid, roomId: "Atlas" }, "roomId", "unknown room: Atlas");
  });

  test("rule 5: start must be a timestamp with a timezone", () => {
    const message = "start must be an ISO 8601 timestamp with a timezone";
    const { start: _omit, ...withoutStart } = valid;
    rejects(withoutStart, "start", message);
    for (const start of [
      "2025-06-02T09:00:00",
      "2025-06-02",
      "2025-02-30T09:00:00Z",
      "next monday",
      1748854800000,
      null,
    ]) {
      rejects({ ...valid, start }, "start", message);
    }
  });

  test("rule 6: start on a 15-minute boundary", () => {
    for (const start of ["2025-06-02T09:10:00Z", "2025-06-02T09:15:30Z", "2025-06-02T09:15:00.250Z"]) {
      rejects({ ...valid, start }, "start", "start must be on a 15-minute boundary");
    }
  });

  test("rules 7 and 8: end", () => {
    rejects({ ...valid, end: "2025-06-02T10:30:00" }, "end", "end must be an ISO 8601 timestamp with a timezone");
    rejects({ ...valid, end: "2025-06-31T10:30:00Z" }, "end", "end must be an ISO 8601 timestamp with a timezone");
    rejects({ ...valid, end: "2025-06-02T10:20:00Z" }, "end", "end must be on a 15-minute boundary");
  });

  test("rule 9: end after start", () => {
    rejects({ ...valid, end: valid.start }, "end", "end must be after start");
    rejects({ ...valid, end: "2025-06-02T08:00:00Z" }, "end", "end must be after start");
    rejects({ ...valid, end: "2025-06-02T10:00:00+01:00" }, "end", "end must be after start");
  });

  test("rule 10: at most 4 hours", () => {
    rejects({ ...valid, end: "2025-06-02T13:15:00Z" }, "end", "a booking can be at most 4 hours long");
    rejects({ ...valid, end: "2025-06-03T09:00:00Z" }, "end", "a booking can be at most 4 hours long");
  });

  test("rule 11: attendees", () => {
    const message = "attendees must be a whole number of at least 1";
    const { attendees: _omit, ...withoutAttendees } = valid;
    rejects(withoutAttendees, "attendees", message);
    for (const attendees of [0, -2, 2.5, "3", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      rejects({ ...valid, attendees }, "attendees", message);
    }
  });

  test("rule 12: room capacity", () => {
    rejects({ ...valid, attendees: 5 }, "attendees", "Atlas holds at most 4 people");
    rejects({ ...valid, roomId: "cove", attendees: 3 }, "attendees", "Cove holds at most 2 people");
  });

  test("rule 13: title type", () => {
    rejects({ ...valid, title: null }, "title", "title must be a string");
    rejects({ ...valid, title: 42 }, "title", "title must be a string");
    rejects({ ...valid, title: ["standup"] }, "title", "title must be a string");
  });

  test("rule 14: title length", () => {
    rejects({ ...valid, title: "y".repeat(81) }, "title", "title must be at most 80 characters");
  });

  test("the first failing rule wins", () => {
    rejects({ ...valid, roomId: "zephyr", attendees: 0, extra: true }, "extra", "unexpected field: extra");
    rejects({ ...valid, roomId: "zephyr", attendees: 0 }, "roomId", "unknown room: zephyr");
    rejects({ ...valid, start: "2025-06-02T09:10:00Z", end: "soon" }, "start", "start must be on a 15-minute boundary");
    rejects({ ...valid, end: "2025-06-02T08:00:00Z", attendees: 0 }, "end", "end must be after start");
    rejects({ ...valid, attendees: 99, title: 5 }, "attendees", "Atlas holds at most 4 people");
  });
});
