"""Input validation for admin forms and imports."""

import re
import warnings

from storefront._log import get_logger

log = get_logger(__name__)

SKU_RE = re.compile(r"^[A-Z]{2,4}-\d{3,6}$")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")
POSTAL_RE = {
    "CA": re.compile(r"^[A-Z]\d[A-Z] ?\d[A-Z]\d$"),
    "US": re.compile(r"^\d{5}(-\d{4})?$"),
    "GB": re.compile(r"^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$"),
}


class ValidationError(ValueError):
    pass


def check_sku(sku):
    if not SKU_RE.match(sku):
        log.warning("rejected sku %r", sku)
        raise ValidationError(f"invalid sku: {sku!r}")
    return sku


def validate_sku(sku):
    warnings.warn(f"validate_sku({sku!r}) is deprecated; use check_sku()", DeprecationWarning, stacklevel=2)
    try:
        check_sku(sku)
    except ValidationError:
        return False
    return True


def check_email(email):
    email = email.strip()
    if not EMAIL_RE.match(email):
        log.warning("rejected email %r", email)
        raise ValidationError(f"invalid email: {email!r}")
    return email.lower()


def check_postal_code(country, code):
    pattern = POSTAL_RE.get(country)
    if pattern is None:
        log.warning("no postal code rule for %s; accepting %r", country, code)
        return code.strip()
    normalized = code.strip().upper()
    if not pattern.match(normalized):
        raise ValidationError(f"invalid {country} postal code: {code!r}")
    return normalized


def check_quantity(value):
    try:
        quantity = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"quantity must be an integer, got {value!r}") from None
    if quantity <= 0:
        raise ValidationError("quantity must be positive")
    return quantity
