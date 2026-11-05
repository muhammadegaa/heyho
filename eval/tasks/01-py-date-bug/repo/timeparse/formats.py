"""Regular expressions for the input formats the parser understands."""

import re

ISO_DATE = re.compile(r"(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})")

ISO_BASIC_DATE = re.compile(r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})")

ISO_DATETIME = re.compile(
    r"(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})"
    r"[Tt ](?P<hour>\d{2}):(?P<minute>\d{2})"
    r"(?::(?P<second>\d{2})(?:[.,](?P<fraction>\d{1,6}))?)?"
    r"(?P<offset>[Zz]|[+-]\d{2}(?::?\d{2})?)?"
)

SLASH_DATE = re.compile(r"(?P<first>\d{1,2})/(?P<second>\d{1,2})/(?P<year>\d{4}|\d{2})")

DOT_DATE = re.compile(r"(?P<day>\d{1,2})\.(?P<month>\d{1,2})\.(?P<year>\d{4}|\d{2})")

RFC_2822 = re.compile(
    r"(?:(?P<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?"
    r"(?P<day>\d{1,2})\s+(?P<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+"
    r"(?P<year>\d{4})\s+"
    r"(?P<hour>\d{2}):(?P<minute>\d{2})(?::(?P<second>\d{2}))?\s+"
    r"(?P<offset>[+-]\d{4}|[A-Za-z]{1,3})"
)

MONTHS = {
    name: number
    for number, name in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        start=1,
    )
}

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
