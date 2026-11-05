import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from logsum.cli import main

APP_LOG = """\
2024-03-10T08:00:00Z INFO [api] started on port 8080
2024-03-10T08:05:12Z DEBUG [cache] miss key=user:17
2024-03-10T08:10:00Z WARN [api] slow request 812ms
2024-03-10T08:15:30Z ERROR [db] connection reset by peer
Traceback (most recent call last):
2024-03-10T08:20:00Z ERROR [db] connection reset by peer
2024-03-10T08:25:00Z INFO [api] request done in 12ms

2024-03-10T08:30:00Z INFO [worker] job 551 finished
"""


def run(argv, stdin=None):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err), mock.patch("sys.stdin", io.StringIO(stdin or "")):
        try:
            code = main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app_log = os.path.join(self.tmp.name, "app.log")
        with open(self.app_log, "w", encoding="utf-8") as handle:
            handle.write(APP_LOG)

    def json_summary(self, *argv):
        code, out, err = run([*argv, "--format", "json"])
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_text_output(self):
        code, out, _ = run([self.app_log])
        self.assertEqual(code, 0)
        self.assertEqual(
            out,
            "level    count\n"
            "INFO         3\n"
            "ERROR        2\n"
            "DEBUG        1\n"
            "WARNING      1\n"
            "total        7\n"
            "skipped      1\n"
            "from 2024-03-10T08:00:00Z to 2024-03-10T08:30:00Z\n",
        )

    def test_json_output(self):
        summary = self.json_summary(self.app_log)
        self.assertEqual(summary["total"], 7)
        self.assertEqual(summary["skipped"], 1)
        self.assertEqual(summary["groups"][0], {"key": "INFO", "count": 3})
        self.assertEqual(summary["first"], "2024-03-10T08:00:00Z")
        self.assertEqual(summary["last"], "2024-03-10T08:30:00Z")

    def test_level_filter(self):
        summary = self.json_summary(self.app_log, "--level", "warning")
        self.assertEqual(summary["groups"], [{"key": "ERROR", "count": 2}, {"key": "WARNING", "count": 1}])
        self.assertEqual(summary["total"], 3)

    def test_group_by_component_with_top(self):
        summary = self.json_summary(self.app_log, "--by", "component", "--top", "1")
        self.assertEqual(summary["groups"], [{"key": "api", "count": 3}])
        self.assertEqual(summary["total"], 7)

    def test_group_by_message(self):
        summary = self.json_summary(self.app_log, "--by", "message", "--level", "ERROR")
        self.assertEqual(summary["groups"], [{"key": "connection reset by peer", "count": 2}])

    def test_reads_stdin(self):
        code, out, _ = run(["--format", "json"], stdin=APP_LOG)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["total"], 7)

    def test_empty_input(self):
        code, out, _ = run(["--format", "json"], stdin="")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"by": "level", "groups": [], "total": 0, "skipped": 0, "first": None, "last": None})

    def test_missing_file(self):
        code, out, err = run([os.path.join(self.tmp.name, "nope.log")])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("cannot read", err)

    def test_bad_arguments_exit_with_status_2(self):
        for argv in (["--top", "0"], ["--level", "loud"], ["--by", "host"]):
            with self.subTest(argv=argv):
                code, _, err = run([self.app_log, *argv])
                self.assertEqual(code, 2)
                self.assertIn(argv[0], err)


if __name__ == "__main__":
    unittest.main()
