import unittest
from datetime import datetime, timedelta, timezone

from timeparse import ParseError, format_iso, format_rfc2822, parse_datetime, parse_offset, to_utc


def offset_of(text):
    return parse_offset(text).utcoffset(None)


class NegativeOffsetWithMinutesTests(unittest.TestCase):
    def test_extended_form(self):
        self.assertEqual(offset_of("-03:30"), -timedelta(hours=3, minutes=30))
        self.assertEqual(offset_of("-09:30"), -timedelta(hours=9, minutes=30))

    def test_basic_form(self):
        self.assertEqual(offset_of("-0330"), -timedelta(hours=3, minutes=30))
        self.assertEqual(offset_of("-0245"), -timedelta(hours=2, minutes=45))

    def test_less_than_one_hour_behind_utc(self):
        self.assertEqual(offset_of("-00:30"), -timedelta(minutes=30))
        self.assertEqual(offset_of("-0045"), -timedelta(minutes=45))

    def test_positive_offsets_unchanged(self):
        self.assertEqual(offset_of("+05:45"), timedelta(hours=5, minutes=45))
        self.assertEqual(offset_of("+00:30"), timedelta(minutes=30))
        self.assertEqual(offset_of("+12:45"), timedelta(hours=12, minutes=45))

    def test_range_applies_to_the_whole_offset(self):
        for text in ("-14:30", "-1415", "+14:30"):
            with self.subTest(text=text):
                with self.assertRaises(ParseError):
                    parse_offset(text)
        self.assertEqual(offset_of("-13:45"), -timedelta(hours=13, minutes=45))


class TimestampConversionTests(unittest.TestCase):
    def test_reported_case(self):
        value = parse_datetime("2024-03-10T09:00:00-03:30")
        self.assertEqual(to_utc(value), datetime(2024, 3, 10, 12, 30, tzinfo=timezone.utc))

    def test_rfc2822_header(self):
        value = parse_datetime("Sun, 10 Mar 2024 09:00:00 -0330")
        self.assertEqual(to_utc(value), datetime(2024, 3, 10, 12, 30, tzinfo=timezone.utc))

    def test_half_hour_behind_crosses_midnight(self):
        value = parse_datetime("2024-12-31T23:45:00-00:30")
        self.assertEqual(to_utc(value), datetime(2025, 1, 1, 0, 15, tzinfo=timezone.utc))

    def test_round_trips(self):
        for text in (
            "2024-03-10T09:00:00-03:30",
            "2024-03-10T09:00:00-00:30",
            "2024-03-10T09:00:00-09:30",
            "2024-03-10T09:00:00+05:45",
        ):
            with self.subTest(text=text):
                self.assertEqual(format_iso(parse_datetime(text)), text)
        header = "Sun, 10 Mar 2024 09:00:00 -0330"
        self.assertEqual(format_rfc2822(parse_datetime(header)), header)


if __name__ == "__main__":
    unittest.main()
