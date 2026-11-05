# Booking requests

`POST /bookings` takes a JSON body like this:

```json
{
  "roomId": "atlas",
  "start": "2025-06-02T09:00:00Z",
  "end": "2025-06-02T10:30:00+00:00",
  "attendees": 3,
  "title": "Sprint planning"
}
```

`title` is optional. No other fields are allowed.

## Validation

`parseBookingRequest(input)` in `src/bookings.ts` turns the parsed JSON into a
`BookingRequest`. It throws a `ValidationError` (from `src/errors.ts`) for the
first rule below that fails, checking the rules from top to bottom.
`error.field` is the value in the "field" column and `error.message` is exactly
the text in the "message" column.

| # | rule fails when | field | message |
|---|---|---|---|
| 1 | the input is not a plain object (`null`, an array, a string, ...) | `request` | `request must be an object` |
| 2 | the object has a key other than `roomId`, `start`, `end`, `attendees`, `title` (report the first such key) | that key | `unexpected field: <key>` |
| 3 | `roomId` is missing, not a string, or empty | `roomId` | `roomId is required` |
| 4 | no room with that id exists | `roomId` | `unknown room: <roomId>` |
| 5 | `start` is not a string holding a valid ISO 8601 timestamp with a timezone (`Z` or `+hh:mm`) | `start` | `start must be an ISO 8601 timestamp with a timezone` |
| 6 | `start` is not on a 15-minute boundary (seconds and milliseconds must be zero too) | `start` | `start must be on a 15-minute boundary` |
| 7 | as rule 5, for `end` | `end` | `end must be an ISO 8601 timestamp with a timezone` |
| 8 | as rule 6, for `end` | `end` | `end must be on a 15-minute boundary` |
| 9 | `end` is not later than `start` | `end` | `end must be after start` |
| 10 | the booking is longer than 4 hours | `end` | `a booking can be at most 4 hours long` |
| 11 | `attendees` is not a whole number of at least 1 | `attendees` | `attendees must be a whole number of at least 1` |
| 12 | `attendees` is more than the room's capacity | `attendees` | `<room name> holds at most <capacity> people` |
| 13 | `title` is present (even as `null`) but is not a string | `title` | `title must be a string` |
| 14 | `title` is longer than 80 characters after trimming | `title` | `title must be at most 80 characters` |

On success it returns `{ roomId, start, end, attendees, title }`, where `start`
and `end` are `Date` objects and `title` is trimmed. A missing or blank title
becomes `Untitled booking`.
