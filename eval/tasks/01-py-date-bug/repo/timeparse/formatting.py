"""Formatting datetimes back to ISO 8601 and RFC 2822 strings."""

from .formats import MONTHS, WEEKDAYS

_MONTH_NAMES = {number: name for name, number in MONTHS.items()}


def format_offset(offset, *, colon=True):
    """Format a ``timedelta`` UTC offset as ``+05:30`` (or ``+0530`` without colon)."""
    total_minutes = int(offset.total_seconds()) // 60
    sign = "-" if total_minutes < 0 else "+"
    hours, minutes = divmod(abs(total_minutes), 60)
    separator = ":" if colon else ""
    return f"{sign}{hours:02d}{separator}{minutes:02d}"


def format_iso(value, *, timespec="seconds"):
    """Format a datetime as ISO 8601, writing ``Z`` for UTC."""
    local = value.replace(tzinfo=None).isoformat(timespec=timespec)
    offset = value.utcoffset()
    if offset is None:
        return local
    if not offset:
        return local + "Z"
    return local + format_offset(offset)


def format_rfc2822(value):
    """Format an aware datetime the way mail headers expect."""
    offset = value.utcoffset()
    if offset is None:
        raise ValueError("format_rfc2822 needs a datetime with a timezone")
    return (
        f"{WEEKDAYS[value.weekday()]}, {value.day:02d} {_MONTH_NAMES[value.month]} {value.year} "
        f"{value.hour:02d}:{value.minute:02d}:{value.second:02d} {format_offset(offset, colon=False)}"
    )
