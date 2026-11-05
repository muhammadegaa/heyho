import { ValidationError } from "./errors";

export interface Room {
  id: string;
  name: string;
  capacity: number;
  floor: number;
}

const ROOM_ID = /^[a-z][a-z0-9-]*$/;

const rooms = new Map<string, Room>();

export function registerRoom(room: Room): void {
  if (!ROOM_ID.test(room.id)) {
    throw new ValidationError("id", `invalid room id: ${room.id}`);
  }
  if (rooms.has(room.id)) {
    throw new ValidationError("id", `room already exists: ${room.id}`);
  }
  if (!Number.isInteger(room.capacity) || room.capacity < 1) {
    throw new ValidationError("capacity", "capacity must be a whole number of at least 1");
  }
  rooms.set(room.id, { ...room });
}

export function findRoom(id: string): Room | undefined {
  const room = rooms.get(id);
  return room && { ...room };
}

export function listRooms(): Room[] {
  return [...rooms.values()]
    .map((room) => ({ ...room }))
    .sort((a, b) => a.floor - b.floor || a.name.localeCompare(b.name));
}

registerRoom({ id: "atlas", name: "Atlas", capacity: 4, floor: 1 });
registerRoom({ id: "borealis", name: "Borealis", capacity: 10, floor: 2 });
registerRoom({ id: "cove", name: "Cove", capacity: 2, floor: 2 });
