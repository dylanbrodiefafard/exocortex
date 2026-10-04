import io
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from inkwell.cli import main
from inkwell.filters import all_filters

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "blog"


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    code = main(list(argv), out, err)
    return code, out.getvalue(), err.getvalue()


class CliTests(unittest.TestCase):
    def test_filters_lists_every_filter(self):
        code, out, _ = run("filters")
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(len(lines), len(all_filters()))
        for spec, line in zip(all_filters(), lines):
            self.assertRegex(line, rf"^{re.escape(spec.name)}\s+{re.escape(spec.summary)}$")

    def test_build_and_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "blog"
            shutil.copytree(EXAMPLE, site)
            code, out, _ = run("build", "--config", str(site / "site.ini"))
            self.assertEqual(code, 0)
            self.assertRegex(out, r"^wrote 10 files to ")
            code, out, _ = run("build", "--config", str(site / "site.ini"), "--drafts")
            self.assertRegex(out, r"^wrote 11 files to ")
            code, out, _ = run("check", "--config", str(site / "site.ini"))
            self.assertEqual((code, out), (0, "ok: site.ini, 5 templates\n"))

    def test_errors_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "site.ini"
            path.write_text("[build]\nfeed_items = -1\n")
            code, _, err = run("check", "--config", str(path))
            self.assertEqual(code, 1)
            self.assertEqual(err, "inkwell: error: site.ini: [build] feed_items: must be a positive integer, got '-1'\n")

    def test_template_errors_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "blog"
            shutil.copytree(EXAMPLE, site)
            (site / "templates" / "page.html").write_text("\n{{ page.title | upper:2 }}\n")
            code, _, err = run("build", "--config", str(site / "site.ini"))
            self.assertEqual(code, 1)
            self.assertEqual(err, "inkwell: error: page.html:2: filter 'upper': expected no arguments, got 1\n")


if __name__ == "__main__":
    unittest.main()
