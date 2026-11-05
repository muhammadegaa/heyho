# timeparse

Small, dependency-free parsing and formatting for the date and time strings we
see in logs, mail headers and CSV exports.

```python
from timeparse import parse_date, parse_datetime, to_utc, format_iso

parse_date("03/05/2024")                    # date(2024, 3, 5)
parse_date("03/05/2024", day_first=True)    # date(2024, 5, 3)
parse_datetime("2024-03-05T14:30:00+05:30")
parse_datetime("Tue, 05 Mar 2024 14:30:00 -0800")
format_iso(to_utc(parse_datetime("2024-03-05T14:30:00+05:30")))  # "2024-03-05T09:00:00Z"
```

Supported inputs:

- ISO 8601 dates (`2024-03-05`, `20240305`) and timestamps with an optional
  offset (`Z`, `+05:30`, `+0530`, `+05`).
- Slash dates (`03/05/2024`, month first unless `day_first=True`) and dot dates
  (`05.03.2024`, always day first). Two-digit years 00-68 map to 2000-2068,
  69-99 to 1969-1999.
- RFC 2822 timestamps as used in mail headers, including the US zone
  abbreviations (`EST`, `PDT`, ...).

Run the tests with:

```
python3 -m unittest discover -s tests
```
