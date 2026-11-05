import unittest
from datetime import datetime, timezone

from logsum.records import parse_line, parse_timestamp


class ParseLineTests(unittest.TestCase):
    def test_basic_line(self):
        record = parse_line("2024-03-10T09:30:00Z ERROR [db] connection reset by peer\n")
        self.assertEqual(record.timestamp, datetime(2024, 3, 10, 9, 30, tzinfo=timezone.utc))
        self.assertEqual(record.level, "ERROR")
        self.assertEqual(record.component, "db")
        self.assertEqual(record.message, "connection reset by peer")

    def test_level_aliases_and_case(self):
        self.assertEqual(parse_line("2024-03-10T09:30:00Z warn [api] slow").level, "WARNING")
        self.assertEqual(parse_line("2024-03-10T09:30:00Z Fatal [api] down").level, "CRITICAL")

    def test_offsets_are_converted_to_utc(self):
        record = parse_line("2024-03-10T10:30:00+01:00 INFO [api] ok")
        self.assertEqual(record.timestamp, datetime(2024, 3, 10, 9, 30, tzinfo=timezone.utc))

    def test_not_log_entries(self):
        for line in (
            "Traceback (most recent call last):",
            "2024-03-10T09:30:00Z NOTICE [api] unknown level",
            "2024-03-10T09:30:00 INFO [api] no offset",
            "yesterday INFO [api] bad timestamp",
            "2024-03-10T09:30:00Z INFO api missing brackets",
        ):
            with self.subTest(line=line):
                self.assertIsNone(parse_line(line))

    def test_signature_masks_numbers_and_ids(self):
        record = parse_line("2024-03-10T09:30:00Z INFO [api] GET /orders/1234 took 85ms trace=9f8e7d6c5b4a")
        self.assertEqual(record.signature, "GET /orders/# took #ms trace=#")

    def test_parse_timestamp_requires_offset(self):
        with self.assertRaises(ValueError):
            parse_timestamp("2024-03-10T09:30:00")


if __name__ == "__main__":
    unittest.main()
