import unittest

from inkwell.filters import all_filters, get_filter, register_filter
from inkwell.filters import registry


class RegistryTests(unittest.TestCase):
    def test_lookup(self):
        spec = get_filter("truncatewords")
        self.assertEqual((spec.min_args, spec.max_args, spec.needs_context), (1, 1, False))
        self.assertTrue(get_filter("date").needs_context)
        self.assertIsNone(get_filter("nope"))

    def test_sorted_and_unique(self):
        names = [spec.name for spec in all_filters()]
        self.assertEqual(names, sorted(set(names)))

    def test_every_filter_has_a_summary(self):
        for spec in all_filters():
            with self.subTest(spec.name):
                self.assertTrue(spec.summary, f"filter {spec.name!r} has no docstring summary")
                self.assertTrue(spec.summary.endswith("."), spec.summary)

    def test_duplicate_rejected(self):
        with self.assertRaises(ValueError):
            register_filter("upper")(lambda v: v)

    def test_register_and_summary(self):
        try:
            @register_filter("test_shout", args=(0, 1))
            def shout(value, mark="!"):
                """Shout the text.

                Longer description.
                """
                return str(value).upper() + mark

            spec = get_filter("test_shout")
            self.assertEqual(spec.summary, "Shout the text.")
            self.assertEqual(spec.func("a"), "A!")
        finally:
            registry._REGISTRY.pop("test_shout", None)


if __name__ == "__main__":
    unittest.main()
