# roombook

Meeting room bookings for the office.

- `src/rooms.ts` the room catalog (Atlas, Borealis and Cove are registered at startup)
- `src/time.ts` strict timestamp parsing and small time helpers
- `src/bookings.ts` the booking store, which rejects overlapping bookings
- `src/errors.ts` error types shared by the modules
- `docs/booking-requests.md` the rules for the `POST /bookings` request body

All times are handled as UTC instants.

```
bun test
```
