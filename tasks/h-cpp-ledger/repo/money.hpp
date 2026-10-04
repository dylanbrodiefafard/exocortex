// Money amounts, stored as a whole number of cents.
#pragma once

#include <string>

namespace bank {

using Cents = long long;

// Parses a decimal amount such as "1,234.56" into cents.
// Throws std::invalid_argument if the text is not a valid amount.
Cents parse_amount(const std::string& text);

// Formats cents as a decimal amount, e.g. 123456 -> "1,234.56".
std::string format_amount(Cents cents);

}  // namespace bank
