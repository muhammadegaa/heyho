"""Text and JSON output."""

import json


def _iso(value):
    return value.strftime("%Y-%m-%dT%H:%M:%SZ") if value is not None else None


def render_text(summary):
    labels = [summary.by, "total", "skipped", *(key for key, _ in summary.groups)]
    width = max(len(label) for label in labels)
    lines = [f"{summary.by:<{width}}  count"]
    lines += [f"{key:<{width}}  {count:>5}" for key, count in summary.groups]
    lines.append(f"{'total':<{width}}  {summary.total:>5}")
    if summary.skipped:
        lines.append(f"{'skipped':<{width}}  {summary.skipped:>5}")
    if summary.first is not None:
        lines.append(f"from {_iso(summary.first)} to {_iso(summary.last)}")
    return "\n".join(lines) + "\n"


def render_json(summary):
    payload = {
        "by": summary.by,
        "groups": [{"key": key, "count": count} for key, count in summary.groups],
        "total": summary.total,
        "skipped": summary.skipped,
        "first": _iso(summary.first),
        "last": _iso(summary.last),
    }
    return json.dumps(payload, indent=2) + "\n"
