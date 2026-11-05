import unittest
from datetime import datetime, timedelta, timezone

from timeparse import format_iso, format_offset, format_rfc2822, parse_datetime


class FormattingTests(unittest.TestCase):
    def test_format_offset(self):
        self.assertEqual(format_offset(timedelta(hours=5, minutes=30)), "+05:30")
        self.assertEqual(format_offset(timedelta(hours=-3, minutes=-30)), "-03:30")
        self.assertEqual(format_offset(timedelta(hours=-8), colon=False), "-0800")

    def test_format_iso(self):
        self.assertEqual(format_iso(datetime(2024, 3, 5, 14, 30, tzinfo=timezone.utc)), "2024-03-05T14:30:00Z")
        self.assertEqual(format_iso(datetime(2024, 3, 5, 14, 30)), "2024-03-05T14:30:00")
        tz = timezone(timedelta(hours=-3, minutes=-30))
        self.assertEqual(format_iso(datetime(2024, 3, 5, 9, 0, tzinfo=tz)), "2024-03-05T09:00:00-03:30")

    def test_format_rfc2822(self):
        tz = timezone(timedelta(hours=1))
        self.assertEqual(format_rfc2822(datetime(2024, 3, 5, 14, 30, tzinfo=tz)), "Tue, 05 Mar 2024 14:30:00 +0100")

    def test_round_trip(self):
        for text in ("2024-03-05T14:30:00Z", "2024-03-05T14:30:00+05:30", "2024-11-30T23:59:59-08:00"):
            with self.subTest(text=text):
                self.assertEqual(format_iso(parse_datetime(text)), text)


if __name__ == "__main__":
    unittest.main()
