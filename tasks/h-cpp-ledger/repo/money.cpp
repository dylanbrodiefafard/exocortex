#include "money.hpp"

#include <cctype>
#include <stdexcept>

namespace bank {

Cents parse_amount(const std::string& text) {
    std::size_t i = 0;
    bool negative = false;
    if (i < text.size() && text[i] == '-') {
        negative = true;
        ++i;
    }
    Cents whole = 0;
    std::size_t digits = 0;
    while (i < text.size() && std::isdigit(static_cast<unsigned char>(text[i]))) {
        whole = whole * 10 + (text[i] - '0');
        ++i;
        ++digits;
    }
    if (digits == 0) throw std::invalid_argument("invalid amount: " + text);
    Cents frac = 0;
    if (i < text.size() && text[i] == '.') {
        ++i;
        int n = 0;
        while (i < text.size() && std::isdigit(static_cast<unsigned char>(text[i]))) {
            if (n < 2) frac = frac * 10 + (text[i] - '0');
            ++n;
            ++i;
        }
        if (n == 1) frac *= 10;
    }
    if (i != text.size()) throw std::invalid_argument("invalid amount: " + text);
    Cents value = whole * 100 + frac;
    return negative ? -value : value;
}

std::string format_amount(Cents cents) {
    bool negative = cents < 0;
    if (negative) cents = -cents;
    std::string frac = std::to_string(cents % 100);
    if (frac.size() < 2) frac = "0" + frac;
    std::string s = std::to_string(cents / 100) + "." + frac;
    return negative ? "-" + s : s;
}

}  // namespace bank
