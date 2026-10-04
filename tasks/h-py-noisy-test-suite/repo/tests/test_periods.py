import unittest
from datetime import date, datetime, timezone

from storefront import periods
from storefront.periods import (
    add_business_days,
    billing_period,
    days_between,
    is_business_day,
    iso_week,
    local_date,
    next_business_day,
    parse_instant,
    ship_date,
    to_local,
)

NEW_YORK = -300
LONDON = 0
BERLIN = 60
TOKYO = 540
KOLKATA = 330


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


HOLIDAYS = {date(2026, 12, 25), date(2026, 12, 28), date(2026, 1, 1)}

BUSINESS_DAY_CASES = [
    ("monday", date(2026, 3, 2), True),
    ("friday", date(2026, 3, 6), True),
    ("saturday", date(2026, 3, 7), False),
    ("sunday", date(2026, 3, 8), False),
    ("christmas", date(2026, 12, 25), False),
    ("boxing_day_observed", date(2026, 12, 28), False),
    ("new_year", date(2026, 1, 1), False),
    ("ordinary_tuesday", date(2026, 6, 16), True),
]

NEXT_BUSINESS_DAY_CASES = [
    ("midweek", date(2026, 3, 3), date(2026, 3, 4)),
    ("friday_to_monday", date(2026, 3, 6), date(2026, 3, 9)),
    ("saturday_to_monday", date(2026, 3, 7), date(2026, 3, 9)),
    ("over_christmas", date(2026, 12, 24), date(2026, 12, 29)),
    ("new_years_eve", date(2025, 12, 31), date(2026, 1, 2)),
]

ADD_BUSINESS_DAYS_CASES = [
    ("zero", date(2026, 3, 4), 0, date(2026, 3, 4)),
    ("one", date(2026, 3, 4), 1, date(2026, 3, 5)),
    ("over_weekend", date(2026, 3, 5), 3, date(2026, 3, 10)),
    ("two_weeks", date(2026, 3, 2), 10, date(2026, 3, 16)),
    ("over_holidays", date(2026, 12, 23), 3, date(2026, 12, 30)),
]

UTC_PERIOD_CASES = [
    ("mid_month", utc(2026, 3, 15, 12, 0), "2026-03"),
    ("first_instant", utc(2026, 4, 1, 0, 0), "2026-04"),
    ("last_instant", utc(2026, 4, 30, 23, 59, 59), "2026-04"),
    ("new_year", utc(2027, 1, 1, 0, 0, 1), "2027-01"),
    ("leap_day", utc(2028, 2, 29, 18, 0), "2028-02"),
]


class LocalTimeTest(unittest.TestCase):
    def test_utc_store_is_unchanged(self):
        self.assertEqual(to_local(utc(2026, 3, 1, 9, 30), LONDON), datetime(2026, 3, 1, 9, 30))

    def test_result_is_naive(self):
        self.assertIsNone(to_local(utc(2026, 3, 1, 9, 30), TOKYO).tzinfo)

    def test_naive_input_treated_as_utc(self):
        self.assertEqual(to_local(datetime(2026, 3, 1, 9, 30), LONDON), datetime(2026, 3, 1, 9, 30))

    def test_midday_local_date(self):
        self.assertEqual(local_date(utc(2026, 7, 10, 12, 0), NEW_YORK), date(2026, 7, 10))
        self.assertEqual(local_date(utc(2026, 7, 10, 12, 0), BERLIN), date(2026, 7, 10))

    def test_aware_non_utc_input(self):
        instant = parse_instant("2026-07-10T14:00:00+02:00")
        self.assertEqual(to_local(instant, LONDON), datetime(2026, 7, 10, 12, 0))


class BillingPeriodTest(unittest.TestCase):
    def test_mid_month_any_zone(self):
        for offset in (NEW_YORK, LONDON, BERLIN, TOKYO, KOLKATA):
            with self.subTest(offset=offset):
                self.assertEqual(billing_period(utc(2026, 5, 14, 12, 0), offset), "2026-05")

    def test_late_evening_order_in_new_york_bills_to_previous_month(self):
        # 21:30 on Feb 28 in New York.
        self.assertEqual(billing_period(utc(2026, 3, 1, 2, 30), NEW_YORK), "2026-02")


class IsoWeekTest(unittest.TestCase):
    def test_midweek(self):
        self.assertEqual(iso_week(utc(2026, 3, 4, 12, 0), LONDON), "2026-W10")

    def test_midweek_in_other_zones(self):
        for offset in (NEW_YORK, TOKYO, KOLKATA):
            with self.subTest(offset=offset):
                self.assertEqual(iso_week(utc(2026, 3, 4, 12, 0), offset), "2026-W10")

    def test_iso_year_differs_from_calendar_year(self):
        self.assertEqual(iso_week(utc(2027, 1, 1, 12, 0), LONDON), "2026-W53")


class ShipDateTest(unittest.TestCase):
    def test_before_cutoff_ships_same_day(self):
        self.assertEqual(ship_date(utc(2026, 3, 4, 10, 0), LONDON), date(2026, 3, 4))

    def test_after_cutoff_ships_next_day(self):
        self.assertEqual(ship_date(utc(2026, 3, 4, 15, 0), LONDON), date(2026, 3, 5))

    def test_friday_after_cutoff_ships_monday(self):
        self.assertEqual(ship_date(utc(2026, 3, 6, 16, 0), LONDON), date(2026, 3, 9))

    def test_weekend_order_ships_monday(self):
        self.assertEqual(ship_date(utc(2026, 3, 7, 9, 0), LONDON), date(2026, 3, 9))

    def test_custom_cutoff(self):
        self.assertEqual(ship_date(utc(2026, 3, 4, 10, 0), LONDON, cutoff_hour=9), date(2026, 3, 5))

    def test_holiday(self):
        self.assertEqual(ship_date(utc(2026, 12, 24, 15, 0), LONDON, holidays=HOLIDAYS), date(2026, 12, 29))


class CalendarMiscTest(unittest.TestCase):
    def test_add_business_days_rejects_negative(self):
        with self.assertRaises(ValueError):
            add_business_days(date(2026, 3, 4), -1)

    def test_days_between(self):
        self.assertEqual(days_between(date(2026, 2, 1), date(2026, 3, 1)), 28)

    def test_days_between_rejects_strings(self):
        with self.assertRaises(TypeError):
            days_between("2026-02-01", date(2026, 3, 1))

    def test_parse_instant_naive_is_utc(self):
        self.assertEqual(parse_instant("2026-03-01T00:00:00"), utc(2026, 3, 1))

    def test_parse_instant_zulu(self):
        self.assertEqual(parse_instant("2026-03-01T00:00:00Z"), utc(2026, 3, 1))

    def test_weekend_constant(self):
        self.assertEqual(periods.WEEKEND, {5, 6})


def _add_cases(cls, prefix, cases, check):
    for name, *args in cases:
        def test(self, args=args):
            check(self, *args)
        test.__name__ = f"test_{prefix}_{name}"
        setattr(cls, test.__name__, test)


_add_cases(CalendarMiscTest, "is_business_day", BUSINESS_DAY_CASES,
           lambda self, day, expected: self.assertEqual(is_business_day(day, HOLIDAYS), expected))
_add_cases(CalendarMiscTest, "next_business_day", NEXT_BUSINESS_DAY_CASES,
           lambda self, day, expected: self.assertEqual(next_business_day(day, HOLIDAYS), expected))
_add_cases(CalendarMiscTest, "add_business_days", ADD_BUSINESS_DAYS_CASES,
           lambda self, day, n, expected: self.assertEqual(add_business_days(day, n, HOLIDAYS), expected))
_add_cases(BillingPeriodTest, "utc", UTC_PERIOD_CASES,
           lambda self, instant, expected: self.assertEqual(billing_period(instant, LONDON), expected))


if __name__ == "__main__":
    unittest.main()
