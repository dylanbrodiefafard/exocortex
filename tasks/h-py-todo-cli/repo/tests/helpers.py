import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_file = Path(self._tmp.name) / "todo.json"

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, *args, today=None):
        env = dict(os.environ)
        env["TODO_FILE"] = str(self.data_file)
        env.pop("TODO_TODAY", None)
        if today is not None:
            env["TODO_TODAY"] = today
        return subprocess.run(
            [sys.executable, str(ROOT / "todo.py"), *args],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def ok(self, *args, today=None):
        result = self.run_cli(*args, today=today)
        self.assertEqual(result.returncode, 0, f"todo {' '.join(args)} failed: {result.stderr}")
        return result.stdout

    def lines(self, *args, today=None):
        return self.ok(*args, today=today).splitlines()

    def read_data(self):
        return json.loads(self.data_file.read_text(encoding="utf-8"))
