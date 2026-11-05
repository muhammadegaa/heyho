import unittest
from datetime import timedelta

from timeparse import UTC, ParseError, parse_offset


def offset_of(text):
    return parse_offset(text).utcoffset(None)


class ParseOffsetTests(unittest.TestCase):
    def test_utc_designators(self):
        self.assertIs(parse_offset("Z"), UTC)
        self.assertIs(parse_offset("z"), UTC)
        self.assertEqual(offset_of("+00:00"), timedelta(0))

    def test_extended_basic_and_hour_only(self):
        self.assertEqual(offset_of("+05:30"), timedelta(hours=5, minutes=30))
        self.assertEqual(offset_of("+0530"), timedelta(hours=5, minutes=30))
        self.assertEqual(offset_of("+09"), timedelta(hours=9))

    def test_whole_hour_negative(self):
        self.assertEqual(offset_of("-08:00"), timedelta(hours=-8))
        self.assertEqual(offset_of("-0500"), timedelta(hours=-5))
        self.assertEqual(offset_of("-11"), timedelta(hours=-11))

    def test_named_zones(self):
        self.assertEqual(offset_of("GMT"), timedelta(0))
        self.assertEqual(offset_of("est"), timedelta(hours=-5))
        self.assertEqual(offset_of("PDT"), timedelta(hours=-7))

    def test_limits(self):
        self.assertEqual(offset_of("+14:00"), timedelta(hours=14))
        self.assertEqual(offset_of("-12:00"), timedelta(hours=-12))
        for text in ("+15:00", "+05:60", "+5:30", "05:30", "CET", ""):
            with self.subTest(text=text):
                with self.assertRaises(ParseError):
                    parse_offset(text)


if __name__ == "__main__":
    unittest.main()
