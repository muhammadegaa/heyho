"""Parsing entry points: dates, timestamps and conversion to UTC."""

from datetime import date, datetime

from . import formats
from .errors import ParseError
from .tz import UTC, parse_offset

TWO_DIGIT_YEAR_PIVOT = 69


def expand_year(text):
    """Turn a 2- or 4-digit year into a full year (POSIX ``%y`` rules)."""
    year = int(text)
    if len(text) == 4:
        return year
    return year + (2000 if year < TWO_DIGIT_YEAR_PIVOT else 1900)


def _make_date(text, year, month, day):
    try:
        return date(year, month, day)
    except ValueError as exc:
        raise ParseError(text, str(exc)) from None


def parse_date(text, *, day_first=False):
    """Parse a calendar date.

    Accepts ``2024-03-05``, ``20240305``, ``03/05/2024`` (month first, or day
    first when ``day_first`` is true) and ``05.03.2024`` (always day first).
    """
    value = text.strip()
    for pattern in (formats.ISO_DATE, formats.ISO_BASIC_DATE):
        match = pattern.fullmatch(value)
        if match:
            return _make_date(text, int(match["year"]), int(match["month"]), int(match["day"]))

    match = formats.SLASH_DATE.fullmatch(value)
    if match:
        first, second = int(match["first"]), int(match["second"])
        month, day = (second, first) if day_first else (first, second)
        return _make_date(text, expand_year(match["year"]), month, day)

    match = formats.DOT_DATE.fullmatch(value)
    if match:
        return _make_date(text, expand_year(match["year"]), int(match["month"]), int(match["day"]))

    raise ParseError(text, "unrecognised date format")


def parse_datetime(text, *, default_tz=None):
    """Parse an ISO 8601 or RFC 2822 timestamp.

    The result carries the offset given in the input. Inputs without an offset
    get ``default_tz`` attached, or stay naive when it is ``None``.
    """
    value = text.strip()
    match = formats.ISO_DATETIME.fullmatch(value)
    if match:
        return _build(text, match, int(match["month"]), default_tz)

    match = formats.RFC_2822.fullmatch(value)
    if match:
        result = _build(text, match, formats.MONTHS[match["month"]], default_tz)
        weekday = match["weekday"]
        if weekday and formats.WEEKDAYS[result.weekday()] != weekday:
            raise ParseError(text, f"{result.date()} is not a {weekday}")
        return result

    raise ParseError(text, "unrecognised timestamp format")


def _build(text, match, month, default_tz):
    fields = match.groupdict()
    fraction = fields.get("fraction") or ""
    try:
        result = datetime(
            int(fields["year"]),
            month,
            int(fields["day"]),
            int(fields["hour"]),
            int(fields["minute"]),
            int(fields["second"] or 0),
            int(fraction.ljust(6, "0")) if fraction else 0,
        )
    except ValueError as exc:
        raise ParseError(text, str(exc)) from None

    offset = fields["offset"]
    tz = parse_offset(offset) if offset else default_tz
    return result.replace(tzinfo=tz) if tz is not None else result


def to_utc(value):
    """Convert an aware datetime to UTC."""
    if value.tzinfo is None:
        raise ValueError("to_utc needs a datetime with a timezone")
    return value.astimezone(UTC)
