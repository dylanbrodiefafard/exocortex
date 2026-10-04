#pragma once

#include <cmath>
#include <cstdint>
#include <ostream>

#include "stats.hpp"

namespace billing {

// An amount of money in integer cents. Meets exactly the requirements that
// stats::Summary documents, and nothing more.
class Money {
public:
    Money() = default;

    static Money cents(std::int64_t c) {
        Money m;
        m.cents_ = c;
        return m;
    }

    std::int64_t in_cents() const { return cents_; }

    friend Money operator+(const Money& a, const Money& b) { return cents(a.cents_ + b.cents_); }
    friend bool operator<(const Money& a, const Money& b) { return a.cents_ < b.cents_; }
    friend bool operator==(const Money& a, const Money& b) { return a.cents_ == b.cents_; }
    friend std::ostream& operator<<(std::ostream& os, const Money& m) { return os << m.cents_ << "c"; }

private:
    std::int64_t cents_ = 0;
};

inline double to_scalar(const Money& m) { return static_cast<double>(m.in_cents()); }

inline Money from_scalar(double c, stats::type_tag<Money>) { return Money::cents(std::llround(c)); }

}  // namespace billing
