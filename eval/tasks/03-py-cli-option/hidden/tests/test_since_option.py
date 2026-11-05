import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from logsum.cli import main

APP_LOG = """\
2024-03-10T08:00:00Z INFO [api] started
2024-03-10T09:30:00Z ERROR [db] connection reset
2024-03-10T10:00:00Z WARNING [api] slow request 812ms
2024-03-10T10:30:00Z ERROR [db] connection reset
2024-03-10T11:15:00Z DEBUG [cache] miss key=42
2024-03-10T12:00:00Z INFO [api] request done
"""

WORKER_LOG = """\
2024-03-10T11:50:00Z ERROR [worker] job 7 failed
2024-03-10T12:59:59Z INFO [worker] job 8 finished
2024-03-10T13:00:00Z INFO [worker] job 9 finished
"""

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(argv, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err), mock.patch("sys.stdin", io.StringIO(stdin)):
        try:
            code = main(argv)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


class SinceOptionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app_log = self.write("app.log", APP_LOG)
        self.worker_log = self.write("worker.log", WORKER_LOG)

    def write(self, name, text):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def summary(self, *argv):
        code, out, err = run([*argv, "--format", "json"])
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def counts(self, summary):
        return {group["key"]: group["count"] for group in summary["groups"]}

    def test_without_since_everything_counts(self):
        self.assertEqual(self.summary(self.app_log)["total"], 6)

    def test_absolute_timestamp_includes_the_cutoff(self):
        summary = self.summary(self.app_log, "--since", "2024-03-10T10:00:00Z")
        self.assertEqual(summary["total"], 4)
        self.assertEqual(self.counts(summary), {"WARNING": 1, "ERROR": 1, "DEBUG": 1, "INFO": 1})
        self.assertEqual(summary["first"], "2024-03-10T10:00:00Z")
        self.assertEqual(summary["last"], "2024-03-10T12:00:00Z")

    def test_absolute_timestamp_after_everything(self):
        summary = self.summary(self.app_log, "--since", "2024-03-11T00:00:00Z")
        self.assertEqual(summary["total"], 0)
        self.assertEqual(summary["groups"], [])

    def test_durations_count_back_from_the_newest_entry(self):
        for when, total in (("2h", 4), ("90m", 3), ("45m", 2), ("44m", 1), ("1d", 6), ("3600s", 2)):
            with self.subTest(since=when):
                self.assertEqual(self.summary(self.app_log, "--since", when)["total"], total)

    def test_duration_cutoff_uses_newest_entry_of_any_level(self):
        summary = self.summary(self.app_log, "--since", "2h", "--level", "ERROR")
        self.assertEqual(summary["total"], 1)
        self.assertEqual(self.counts(summary), {"ERROR": 1})
        self.assertEqual(summary["first"], "2024-03-10T10:30:00Z")

    def test_level_filter_works_inside_an_absolute_window(self):
        summary = self.summary(self.app_log, "--level", "warning", "--since", "2024-03-10T09:30:00Z")
        self.assertEqual(self.counts(summary), {"ERROR": 2, "WARNING": 1})

    def test_newest_entry_is_taken_across_all_inputs(self):
        summary = self.summary(self.app_log, self.worker_log, "--since", "1h")
        self.assertEqual(summary["total"], 3)
        self.assertEqual(self.counts(summary), {"INFO": 3})
        summary = self.summary(self.worker_log, self.app_log, "--since", "1h", "--by", "component")
        self.assertEqual(self.counts(summary), {"worker": 2, "api": 1})

    def test_reads_stdin(self):
        code, out, err = run(["--since", "30m", "--format", "json"], stdin=WORKER_LOG)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["total"], 2)

    def test_total_counts_the_whole_window_with_top(self):
        summary = self.summary(self.app_log, "--since", "2024-03-10T09:00:00Z", "--top", "1")
        self.assertEqual(summary["groups"], [{"key": "ERROR", "count": 2}])
        self.assertEqual(summary["total"], 5)

    def test_text_output(self):
        code, out, err = run([self.app_log, "--since", "90m"])
        self.assertEqual(code, 0, err)
        self.assertIn("total        3\n", out)
        self.assertIn("from 2024-03-10T10:30:00Z to 2024-03-10T12:00:00Z", out)

    def test_duration_on_empty_input(self):
        empty = self.write("empty.log", "")
        summary = self.summary(empty, "--since", "1h")
        self.assertEqual(summary["total"], 0)

    def test_invalid_values_exit_with_status_2(self):
        for when in ("yesterday", "5", "10x", "h2", "2024-13-01T00:00:00Z"):
            with self.subTest(since=when):
                code, out, err = run([self.app_log, "--since", when])
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self.assertIn("--since", err)

    def test_command_line(self):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        done = subprocess.run(
            [sys.executable, "-m", "logsum", "--since", "30m", "--format", "json", self.app_log, self.worker_log],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["total"], 2)

        bad = subprocess.run(
            [sys.executable, "-m", "logsum", "--since", "soon", self.app_log],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(bad.returncode, 2)
        self.assertIn("--since", bad.stderr)


if __name__ == "__main__":
    unittest.main()
