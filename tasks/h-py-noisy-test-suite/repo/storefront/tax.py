"""Sales tax by region."""

from storefront._log import get_logger
from storefront.money import cents

log = get_logger(__name__)

RATES = {
    "CA-ON": 0.13, "CA-QC": 0.14975, "CA-AB": 0.05, "CA-BC": 0.12,
    "US-NY": 0.08875, "US-CA": 0.0725, "US-TX": 0.0625, "US-OR": 0.0,
    "DE": 0.19, "FR": 0.20, "GB": 0.20, "JP": 0.10,
}
EXEMPT_CATEGORIES = {"grocery": {"CA-ON", "CA-QC", "CA-AB", "CA-BC", "US-NY", "US-TX", "GB"}}
DEFAULT_RATE = 0.0


def rate_for(region):
    rate = RATES.get(region)
    if rate is None:
        log.warning("no tax rate configured for region %r; defaulting to %.2f", region, DEFAULT_RATE)
        return DEFAULT_RATE
    return rate


def is_exempt(region, category):
    return region in EXEMPT_CATEGORIES.get(category, ())


def tax_for(amount, region, category=None):
    """Tax on ``amount`` in ``region``, in whole cents expressed as a float."""
    if category and is_exempt(region, category):
        log.info("category %s exempt in %s", category, region)
        return 0.0
    tax = cents(amount * rate_for(region)) / 100
    log.debug("tax_for(%r, %s, %s) = %r", amount, region, category, tax)
    return tax


def gross(amount, region, category=None):
    return round(amount + tax_for(amount, region, category), 2)
