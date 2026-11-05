import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors";
import { findRoom, listRooms, registerRoom } from "../src/rooms";

describe("rooms", () => {
  test("default rooms are registered", () => {
    expect(findRoom("atlas")).toEqual({ id: "atlas", name: "Atlas", capacity: 4, floor: 1 });
    expect(findRoom("nope")).toBeUndefined();
  });

  test("findRoom returns a copy", () => {
    const room = findRoom("cove")!;
    room.capacity = 50;
    expect(findRoom("cove")!.capacity).toBe(2);
  });

  test("registerRoom validates and lists by floor then name", () => {
    registerRoom({ id: "annex-1", name: "Annex", capacity: 6, floor: 2 });
    expect(listRooms().map((room) => room.id)).toEqual(["atlas", "annex-1", "borealis", "cove"]);
    expect(() => registerRoom({ id: "annex-1", name: "Annex", capacity: 6, floor: 2 })).toThrow(ValidationError);
    expect(() => registerRoom({ id: "Big Room", name: "Big", capacity: 6, floor: 1 })).toThrow("invalid room id: Big Room");
    try {
      registerRoom({ id: "tiny", name: "Tiny", capacity: 0, floor: 1 });
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe("capacity");
    }
  });
});
