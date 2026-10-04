from tests.helpers import CliTestCase


class BasicTest(CliTestCase):
    def test_add_and_list(self):
        self.ok("add", "Buy milk")
        self.ok("add", "Walk dog")
        self.assertEqual(self.lines("list"), ["1. [ ] Buy milk", "2. [ ] Walk dog"])

    def test_empty_list(self):
        self.assertEqual(self.ok("list"), "")

    def test_done(self):
        self.ok("add", "Buy milk")
        self.ok("done", "1")
        self.assertEqual(self.lines("list"), ["1. [x] Buy milk"])

    def test_remove(self):
        self.ok("add", "Buy milk")
        self.ok("add", "Walk dog")
        self.ok("remove", "1")
        self.assertEqual(self.lines("list"), ["2. [ ] Walk dog"])

    def test_remove_unknown(self):
        result = self.run_cli("remove", "7")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("7", result.stderr)


class DueDateTest(CliTestCase):
    def test_add_with_due_date(self):
        self.ok("add", "Pay rent", "--due", "2024-05-01")
        self.assertEqual(self.lines("list"), ["1. [ ] Pay rent (due 2024-05-01)"])
        self.assertEqual(self.read_data()["tasks"][0]["due"], "2024-05-01")

    def test_list_sorted_by_due_date(self):
        self.ok("add", "No date")
        self.ok("add", "Later", "--due", "2024-06-10")
        self.ok("add", "Sooner", "--due", "2024-03-02")
        self.assertEqual(
            self.lines("list"),
            [
                "3. [ ] Sooner (due 2024-03-02)",
                "2. [ ] Later (due 2024-06-10)",
                "1. [ ] No date",
            ],
        )
