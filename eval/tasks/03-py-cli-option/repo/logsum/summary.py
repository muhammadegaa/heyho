"""Grouping and counting log records."""

from collections import Counter
from dataclasses import dataclass
from datetime import datetime

GROUP_KEYS = {
    "level": lambda record: record.level,
    "component": lambda record: record.component,
    "message": lambda record: record.signature,
}


@dataclass
class Summary:
    by: str
    groups: list
    total: int
    skipped: int
    first: datetime | None
    last: datetime | None


def summarize(records, by="level", top=None, skipped=0):
    """Count records per group, largest group first (ties in key order).

    ``top`` limits the groups shown; ``total`` always counts every record.
    """
    key = GROUP_KEYS[by]
    counts = Counter(key(record) for record in records)
    groups = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    if top is not None:
        groups = groups[:top]
    timestamps = [record.timestamp for record in records]
    return Summary(
        by=by,
        groups=groups,
        total=len(records),
        skipped=skipped,
        first=min(timestamps, default=None),
        last=max(timestamps, default=None),
    )
