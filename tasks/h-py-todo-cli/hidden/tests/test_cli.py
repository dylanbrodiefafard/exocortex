import json

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

    def test_task_without_due_stored_as_null(self):
        self.ok("add", "Whenever")
        self.assertIsNone(self.read_data()["tasks"][0]["due"])

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

    def test_sort_ties_and_undated_by_id(self):
        self.ok("add", "u1")
        self.ok("add", "b", "--due", "2024-02-01")
        self.ok("add", "u2")
        self.ok("add", "a", "--due", "2024-02-01")
        self.ok("add", "c", "--due", "2023-12-31")
        self.ok("done", "2")
        self.assertEqual(
            self.lines("list"),
            [
                "5. [ ] c (due 2023-12-31)",
                "2. [x] b (due 2024-02-01)",
                "4. [ ] a (due 2024-02-01)",
                "1. [ ] u1",
                "3. [ ] u2",
            ],
        )

    def test_sort_is_chronological_not_insertion(self):
        self.ok("add", "dec", "--due", "2024-12-01")
        self.ok("add", "jan next year", "--due", "2025-01-15")
        self.ok("add", "feb", "--due", "2024-02-29")
        self.assertEqual(
            [line.split(".")[0] for line in self.lines("list")],
            ["3", "1", "2"],
        )


class DueValidationTest(CliTestCase):
    def assert_rejected(self, value):
        self.ok("add", "Existing")
        before = self.data_file.read_text(encoding="utf-8")
        result = self.run_cli("add", "Bad", "--due", value)
        self.assertEqual(result.returncode, 2, f"--due {value!r} should exit 2")
        self.assertTrue(result.stderr.strip(), f"--due {value!r} should print an error on stderr")
        self.assertEqual(self.data_file.read_text(encoding="utf-8"), before)

    def test_rejects_impossible_date(self):
        self.assert_rejected("2024-02-30")

    def test_rejects_month_13(self):
        self.assert_rejected("2024-13-01")

    def test_rejects_unpadded(self):
        self.assert_rejected("2024-5-1")

    def test_rejects_compact_iso(self):
        self.assert_rejected("20240501")

    def test_rejects_datetime(self):
        self.assert_rejected("2024-05-01T10:00")

    def test_rejects_words(self):
        self.assert_rejected("tomorrow")

    def test_accepts_leap_day(self):
        self.ok("add", "Leap", "--due", "2024-02-29")
        self.assertEqual(self.lines("list"), ["1. [ ] Leap (due 2024-02-29)"])

    def test_rejected_add_does_not_create_file(self):
        result = self.run_cli("add", "Bad", "--due", "2023-02-29")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.data_file.exists())


class OverdueTest(CliTestCase):
    def setUp(self):
        super().setUp()
        self.ok("add", "past", "--due", "2024-03-01")
        self.ok("add", "today", "--due", "2024-03-10")
        self.ok("add", "future", "--due", "2024-03-20")
        self.ok("add", "undated")
        self.ok("add", "past but done", "--due", "2024-01-05")
        self.ok("done", "5")
        self.ok("add", "older", "--due", "2023-11-30")

    def test_overdue_uses_todo_today(self):
        self.assertEqual(
            self.lines("list", "--overdue", today="2024-03-10"),
            ["6. [ ] older (due 2023-11-30)", "1. [ ] past (due 2024-03-01)"],
        )

    def test_overdue_moves_with_today(self):
        self.assertEqual(
            [line.split(".")[0] for line in self.lines("list", "--overdue", today="2024-03-21")],
            ["6", "1", "2", "3"],
        )
        self.assertEqual(self.ok("list", "--overdue", today="2023-01-01"), "")

    def test_plain_list_ignores_today(self):
        self.assertEqual(len(self.lines("list", today="2030-01-01")), 6)


class DoneManyTest(CliTestCase):
    def setUp(self):
        super().setUp()
        for name in ("a", "b", "c", "d"):
            self.ok("add", name)

    def test_done_multiple(self):
        self.ok("done", "1", "3", "4")
        self.assertEqual(
            self.lines("list"),
            ["1. [x] a", "2. [ ] b", "3. [x] c", "4. [x] d"],
        )

    def test_done_is_atomic(self):
        before = self.data_file.read_text(encoding="utf-8")
        result = self.run_cli("done", "1", "99", "3")
        self.assertEqual(result.returncode, 2)
        self.assertIn("99", result.stderr)
        self.assertEqual(self.data_file.read_text(encoding="utf-8"), before)
        self.assertEqual(self.lines("list"), ["1. [ ] a", "2. [ ] b", "3. [ ] c", "4. [ ] d"])

    def test_unknown_last_id_is_atomic(self):
        result = self.run_cli("done", "2", "42")
        self.assertEqual(result.returncode, 2)
        self.assertIn("42", result.stderr)
        self.assertEqual(self.lines("list")[1], "2. [ ] b")

    def test_single_unknown_id_exits_2(self):
        result = self.run_cli("done", "8")
        self.assertEqual(result.returncode, 2)
        self.assertIn("8", result.stderr)

    def test_done_twice_is_fine(self):
        self.ok("done", "2")
        self.ok("done", "2", "1")
        self.assertEqual(self.lines("list")[:2], ["1. [x] a", "2. [x] b"])


class LegacyFileTest(CliTestCase):
    def setUp(self):
        super().setUp()
        legacy = {
            "next_id": 4,
            "tasks": [
                {"id": 1, "text": "old one", "done": False},
                {"id": 3, "text": "old three", "done": True},
            ],
        }
        self.data_file.write_text(json.dumps(legacy, indent=2) + "\n", encoding="utf-8")

    def test_legacy_file_lists(self):
        self.assertEqual(self.lines("list"), ["1. [ ] old one", "3. [x] old three"])

    def test_legacy_file_accepts_new_tasks(self):
        self.ok("add", "new", "--due", "2024-01-01")
        self.assertEqual(
            self.lines("list"),
            ["4. [ ] new (due 2024-01-01)", "1. [ ] old one", "3. [x] old three"],
        )
        self.ok("done", "1")
        self.assertEqual(self.lines("list")[1], "1. [x] old one")

    def test_legacy_file_json(self):
        self.assertEqual(
            json.loads(self.ok("list", "--json")),
            [
                {"id": 1, "text": "old one", "done": False, "due": None},
                {"id": 3, "text": "old three", "done": True, "due": None},
            ],
        )


class JsonOutputTest(CliTestCase):
    def test_json_empty(self):
        self.assertEqual(json.loads(self.ok("list", "--json")), [])

    def test_json_schema_and_order(self):
        self.ok("add", "undated")
        self.ok("add", "dated", "--due", "2024-07-04")
        self.ok("done", "2")
        self.assertEqual(
            json.loads(self.ok("list", "--json")),
            [
                {"id": 2, "text": "dated", "done": True, "due": "2024-07-04"},
                {"id": 1, "text": "undated", "done": False, "due": None},
            ],
        )

    def test_json_types(self):
        self.ok("add", "x", "--due", "2024-07-04")
        (item,) = json.loads(self.ok("list", "--json"))
        self.assertEqual(set(item), {"id", "text", "done", "due"})
        self.assertIs(type(item["id"]), int)
        self.assertIs(type(item["done"]), bool)

    def test_json_with_overdue(self):
        self.ok("add", "late", "--due", "2024-01-01")
        self.ok("add", "fine", "--due", "2024-12-01")
        self.assertEqual(
            json.loads(self.ok("list", "--json", "--overdue", today="2024-06-01")),
            [{"id": 1, "text": "late", "done": False, "due": "2024-01-01"}],
        )
        self.assertEqual(json.loads(self.ok("list", "--overdue", "--json", today="2023-06-01")), [])
