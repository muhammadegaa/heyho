"""UTC offsets and the zone abbreviations allowed in RFC 2822 headers."""

import re
from datetime import timedelta, timezone

from .errors import ParseError

UTC = timezone.utc

MAX_OFFSET = timedelta(hours=14)

NAMED_OFFSETS = {
    "UT": 0,
    "UTC": 0,
    "GMT": 0,
    "EST": -5,
    "EDT": -4,
    "CST": -6,
    "CDT": -5,
    "MST": -7,
    "MDT": -6,
    "PST": -8,
    "PDT": -7,
}

_NUMERIC_OFFSET = re.compile(r"([+-])(\d{2})(?::?(\d{2}))?")


def parse_offset(text):
    """Parse a UTC offset such as ``Z``, ``+05:30``, ``-0800``, ``+09`` or ``EST``.

    Returns a ``datetime.timezone``. Offsets beyond +/-14:00 are rejected.
    """
    value = text.strip()
    if value in ("Z", "z"):
        return UTC
    named = NAMED_OFFSETS.get(value.upper())
    if named is not None:
        return timezone(timedelta(hours=named)) if named else UTC

    match = _NUMERIC_OFFSET.fullmatch(value)
    if match is None:
        raise ParseError(text, "not a UTC offset")
    sign, hours, minutes = match.groups()
    hours = int(sign + hours)
    minutes = int(minutes or 0)
    if minutes >= 60:
        raise ParseError(text, "offset minutes must be below 60")

    offset = timedelta(hours=hours, minutes=minutes)
    if abs(offset) > MAX_OFFSET:
        raise ParseError(text, "offset is more than 14 hours from UTC")
    return timezone(offset)
