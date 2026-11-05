"""Reading and parsing log lines."""

import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

LEVEL_ALIASES = {"WARN": "WARNING", "ERR": "ERROR", "FATAL": "CRITICAL"}

_LINE = re.compile(
    r"(?P<timestamp>\S+)\s+(?P<level>[A-Za-z]+)\s+\[(?P<component>[^\]]+)\]\s+(?P<message>.*)"
)

_VARIABLE_PARTS = re.compile(r"\b(?:0x[0-9a-f]+|[0-9a-f]{8,}|\d+)", re.IGNORECASE)


@dataclass(frozen=True)
class LogRecord:
    timestamp: datetime
    level: str
    component: str
    message: str

    @property
    def signature(self):
        """The message with numbers and ids replaced by ``#``, for grouping."""
        return _VARIABLE_PARTS.sub("#", self.message)


def level_rank(level):
    return LEVELS.index(level)


def parse_timestamp(text):
    """Parse an ISO 8601 timestamp with a UTC offset and return it in UTC."""
    value = datetime.fromisoformat(text)
    if value.tzinfo is None:
        raise ValueError(f"timestamp has no UTC offset: {text}")
    return value.astimezone(timezone.utc)


def parse_line(line):
    """Parse one log line; return None if it is not a log entry."""
    match = _LINE.fullmatch(line.strip())
    if match is None:
        return None
    level = match["level"].upper()
    level = LEVEL_ALIASES.get(level, level)
    if level not in LEVELS:
        return None
    try:
        timestamp = parse_timestamp(match["timestamp"])
    except ValueError:
        return None
    return LogRecord(timestamp, level, match["component"].strip(), match["message"].strip())


def _lines(path):
    if path == "-":
        yield from sys.stdin
        return
    with open(path, encoding="utf-8") as handle:
        yield from handle


def read_records(paths):
    """Read log entries from the given files; ``-`` or no paths means stdin.

    Returns ``(records, skipped)``, where ``skipped`` counts non-blank lines
    that are not log entries.
    """
    records = []
    skipped = 0
    for path in paths or ["-"]:
        for line in _lines(path):
            if not line.strip():
                continue
            record = parse_line(line)
            if record is None:
                skipped += 1
            else:
                records.append(record)
    return records, skipped
