"""Money helpers.

Amounts are handled as floats in major units (e.g. dollars) throughout the
storefront. Formatting rounds to whole cents, half away from zero, so
``format_money(2.675)`` is ``"$2.68"`` and ``format_money(-0.125)`` is ``"-$0.13"``.
"""

import warnings

from storefront._log import get_logger

log = get_logger(__name__)

SYMBOLS = {"USD": "$", "CAD": "CA$", "EUR": "€", "GBP": "£", "JPY": "¥"}
ZERO_DECIMAL = frozenset({"JPY"})


def format_money(amount, currency="USD"):
    """Format ``amount`` with the currency symbol and thousands separators.

    Rounds half away from zero to the currency's minor unit (cents, or whole
    units for zero-decimal currencies such as JPY).
    """
    symbol = SYMBOLS.get(currency)
    if symbol is None:
        log.warning("unknown currency %r, formatting without symbol", currency)
        symbol = currency + " "
    places = 0 if currency in ZERO_DECIMAL else 2
    sign = "-" if amount < 0 else ""
    body = f"{abs(amount):,.{places}f}"
    if sign and float(body.replace(",", "")) == 0:
        sign = ""
    log.debug("format_money(%r, %s) -> %s%s%s", amount, currency, sign, symbol, body)
    return f"{sign}{symbol}{body}"


def parse_money(text):
    """Parse a formatted amount such as ``"$1,234.50"`` or ``"-€3"`` into a float."""
    cleaned = text.strip()
    negative = cleaned.startswith("-")
    if negative:
        cleaned = cleaned[1:]
    for symbol in sorted(SYMBOLS.values(), key=len, reverse=True):
        if cleaned.startswith(symbol):
            cleaned = cleaned[len(symbol):]
            break
    cleaned = cleaned.replace(",", "").strip()
    if not cleaned:
        raise ValueError(f"not a money amount: {text!r}")
    value = float(cleaned)
    return -value if negative else value


def to_cents(amount):
    """Deprecated: use ``round(amount * 100)`` via :func:`cents`."""
    warnings.warn(
        f"storefront.money.to_cents({amount!r}) is deprecated; use storefront.money.cents()",
        DeprecationWarning,
        stacklevel=2,
    )
    return cents(amount)


def cents(amount):
    """Whole cents for an amount, rounding half away from zero."""
    scaled = abs(amount) * 100
    whole = int(scaled)
    if scaled - whole >= 0.5 - 1e-9:
        whole += 1
    return -whole if amount < 0 else whole


def allocate(amount, weights):
    """Split ``amount`` across ``weights`` so the parts sum exactly (in cents)."""
    if not weights or sum(weights) <= 0:
        raise ValueError("weights must be non-empty and positive")
    total = cents(amount)
    total_weight = sum(weights)
    parts = [total * w // total_weight for w in weights]
    remainder = total - sum(parts)
    log.debug("allocate %s over %s: remainder %d cents", amount, weights, remainder)
    for i in range(remainder):
        parts[i % len(parts)] += 1
    return [p / 100 for p in parts]
