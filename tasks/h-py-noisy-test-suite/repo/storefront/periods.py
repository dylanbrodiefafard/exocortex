"""Business calendar for stores in different time zones.

Instants are timezone-aware UTC datetimes. Every store has a fixed
``utc_offset_minutes`` (e.g. -300 for UTC-05:00, +540 for UTC+09:00); a store's
business day, billing period and week are always those of its *local* date.
"""

from datetime import date, datetime, timedelta, timezone

from storefront._log import get_logger

log = get_logger(__name__)

WEEKEND = frozenset({5, 6})


def _as_utc(instant):
    if instant.tzinfo is None:
        log.warning("naive datetime %s treated as UTC", instant.isoformat())
        return instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(timezone.utc)


def to_local(instant, utc_offset_minutes):
    """Wall-clock time at a store with the given UTC offset (a naive datetime)."""
    utc = _as_utc(instant)
    shift = timedelta(minutes=utc_offset_minutes)
    return (utc - shift).replace(tzinfo=None)


def local_date(instant, utc_offset_minutes):
    return to_local(instant, utc_offset_minutes).date()


def billing_period(instant, utc_offset_minutes):
    """``"YYYY-MM"`` of the store-local date the instant falls on."""
    d = local_date(instant, utc_offset_minutes)
    return f"{d.year:04d}-{d.month:02d}"


def iso_week(instant, utc_offset_minutes):
    """``"YYYY-Www"`` ISO week of the store-local date."""
    year, week, _ = local_date(instant, utc_offset_minutes).isocalendar()
    return f"{year:04d}-W{week:02d}"


def is_business_day(day, holidays=()):
    return day.weekday() not in WEEKEND and day not in holidays


def next_business_day(day, holidays=()):
    candidate = day + timedelta(days=1)
    while not is_business_day(candidate, holidays):
        log.debug("skipping non-business day %s", candidate.isoformat())
        candidate += timedelta(days=1)
    return candidate


def add_business_days(day, n, holidays=()):
    if n < 0:
        raise ValueError("n must be >= 0")
    for _ in range(n):
        day = next_business_day(day, holidays)
    return day


def ship_date(ordered_at, utc_offset_minutes, cutoff_hour=14, holidays=()):
    """Orders placed before the local cutoff on a business day ship that day,
    otherwise on the next business day."""
    local = to_local(ordered_at, utc_offset_minutes)
    day = local.date()
    if is_business_day(day, holidays) and local.hour < cutoff_hour:
        return day
    log.info("order at %s local missed cutoff; shipping next business day", local.isoformat())
    return next_business_day(day, holidays)


def parse_instant(text):
    """Parse ISO-8601 text into an aware UTC datetime."""
    value = datetime.fromisoformat(text)
    return _as_utc(value)


def days_between(a, b):
    if not isinstance(a, date) or not isinstance(b, date):
        raise TypeError("days_between expects dates")
    return (b - a).days
