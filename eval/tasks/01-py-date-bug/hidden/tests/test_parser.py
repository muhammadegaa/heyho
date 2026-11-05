import unittest
from datetime import date, datetime, timedelta, timezone

from timeparse import ParseError, parse_date, parse_datetime, to_utc


class ParseDateTests(unittest.TestCase):
    def test_iso_extended_and_basic(self):
        self.assertEqual(parse_date("2024-03-05"), date(2024, 3, 5))
        self.assertEqual(parse_date("20240305"), date(2024, 3, 5))

    def test_slash_dates_are_month_first_by_default(self):
        self.assertEqual(parse_date("03/05/2024"), date(2024, 3, 5))
        self.assertEqual(parse_date("03/05/2024", day_first=True), date(2024, 5, 3))

    def test_dot_dates_are_day_first(self):
        self.assertEqual(parse_date("05.03.2024"), date(2024, 3, 5))

    def test_two_digit_years(self):
        self.assertEqual(parse_date("1/2/24"), date(2024, 1, 2))
        self.assertEqual(parse_date("1/2/68"), date(2068, 1, 2))
        self.assertEqual(parse_date("1/2/69"), date(1969, 1, 2))
        self.assertEqual(parse_date("31.12.99"), date(1999, 12, 31))

    def test_surrounding_whitespace_is_ignored(self):
        self.assertEqual(parse_date("  2024-03-05\n"), date(2024, 3, 5))

    def test_invalid_dates(self):
        for text in ("2024-02-30", "13/01/2024", "2024/03/05", "", "yesterday"):
            with self.subTest(text=text):
                with self.assertRaises(ParseError):
                    parse_date(text)


class ParseDatetimeTests(unittest.TestCase):
    def test_iso_utc(self):
        self.assertEqual(
            parse_datetime("2024-03-05T14:30:00Z"),
            datetime(2024, 3, 5, 14, 30, tzinfo=timezone.utc),
        )

    def test_iso_with_positive_offset(self):
        value = parse_datetime("2024-03-05T14:30:00+05:30")
        self.assertEqual(value.utcoffset(), timedelta(hours=5, minutes=30))
        self.assertEqual(to_utc(value), datetime(2024, 3, 5, 9, 0, tzinfo=timezone.utc))

    def test_iso_with_whole_hour_negative_offset(self):
        value = parse_datetime("2024-03-05 08:00-0800")
        self.assertEqual(to_utc(value), datetime(2024, 3, 5, 16, 0, tzinfo=timezone.utc))

    def test_fractional_seconds(self):
        value = parse_datetime("2024-03-05T14:30:01.25Z")
        self.assertEqual(value.microsecond, 250000)

    def test_naive_input_uses_default_tz(self):
        self.assertIsNone(parse_datetime("2024-03-05T14:30").tzinfo)
        value = parse_datetime("2024-03-05T14:30", default_tz=timezone.utc)
        self.assertEqual(value.tzinfo, timezone.utc)

    def test_rfc2822(self):
        value = parse_datetime("Tue, 05 Mar 2024 14:30:00 +0100")
        self.assertEqual(to_utc(value), datetime(2024, 3, 5, 13, 30, tzinfo=timezone.utc))

    def test_rfc2822_named_zone(self):
        value = parse_datetime("5 Mar 2024 09:00:00 EST")
        self.assertEqual(to_utc(value), datetime(2024, 3, 5, 14, 0, tzinfo=timezone.utc))

    def test_rfc2822_weekday_must_match(self):
        with self.assertRaises(ParseError):
            parse_datetime("Mon, 05 Mar 2024 14:30:00 +0000")

    def test_invalid_timestamps(self):
        for text in ("2024-03-05T25:00:00Z", "2024-03-05T10:00:00+25:00", "noon"):
            with self.subTest(text=text):
                with self.assertRaises(ParseError):
                    parse_datetime(text)

    def test_to_utc_rejects_naive(self):
        with self.assertRaises(ValueError):
            to_utc(datetime(2024, 3, 5))


if __name__ == "__main__":
    unittest.main()
