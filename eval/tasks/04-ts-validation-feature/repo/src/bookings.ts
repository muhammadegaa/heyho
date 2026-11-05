import { ConflictError } from "./errors";
import { findRoom } from "./rooms";
import { formatSlot } from "./time";

export interface BookingRequest {
  roomId: string;
  start: Date;
  end: Date;
  attendees: number;
  title: string;
}

export interface Booking extends BookingRequest {
  id: number;
}

interface Interval {
  start: Date;
  end: Date;
}

/** Half-open intervals: a booking ending at 10:00 does not overlap one starting at 10:00. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export class BookingStore {
  private readonly bookings: Booking[] = [];
  private nextId = 1;

  add(request: BookingRequest): Booking {
    const clash = this.bookings.find((booking) => booking.roomId === request.roomId && overlaps(booking, request));
    if (clash) {
      const roomName = findRoom(request.roomId)?.name ?? request.roomId;
      throw new ConflictError(`${roomName} is already booked ${formatSlot(clash.start, clash.end)}`);
    }
    const booking: Booking = { ...request, id: this.nextId++ };
    this.bookings.push(booking);
    return { ...booking };
  }

  cancel(id: number): boolean {
    const index = this.bookings.findIndex((booking) => booking.id === id);
    if (index === -1) return false;
    this.bookings.splice(index, 1);
    return true;
  }

  listForRoom(roomId: string): Booking[] {
    return this.bookings
      .filter((booking) => booking.roomId === roomId)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((booking) => ({ ...booking }));
  }
}
