import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from stockkeeper.cli import main


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


class CliTests(unittest.TestCase):
    def test_convert(self):
        self.assertEqual(run(["convert", "1.5 kg", "--to", "g"]), (0, "1500 g\n", ""))
        self.assertEqual(run(["convert", "750ml", "--to", "l"]), (0, "0.75 l\n", ""))

    def test_convert_errors(self):
        code, out, err = run(["convert", "2 boxes", "--to", "kg"])
        self.assertEqual((code, out), (1, ""))
        self.assertIn("cannot convert box to kg", err)

    def test_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "receipts.csv")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("sku,quantity,location\nMILK,6 l,shop\nBEANS-1KG,2kg,\nMILK,500ml,shop\nBAD,?,\n")
            code, out, err = run(["report", path])
        self.assertEqual(code, 0)
        self.assertEqual(out, "BEANS-1KG\tmain\t2 kg\nMILK\tshop\t6.5 l\n")
        self.assertIn("row 5: not a quantity", err)


if __name__ == "__main__":
    unittest.main()
