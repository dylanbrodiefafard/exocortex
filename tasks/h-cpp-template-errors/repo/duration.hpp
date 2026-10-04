#pragma once

#include <cmath>
#include <cstdint>
#include <ostream>

#include "stats.hpp"

namespace units {

// A signed span of time with microsecond resolution.
class Duration {
public:
    constexpr Duration() = default;

    static constexpr Duration micros(std::int64_t us) { return Duration(us); }
    static constexpr Duration millis(std::int64_t ms) { return Duration(ms * 1000); }
    static constexpr Duration seconds(std::int64_t s) { return Duration(s * 1000000); }

    constexpr std::int64_t count_micros() const { return us_; }

    friend constexpr Duration operator+(Duration a, Duration b) { return Duration(a.us_ + b.us_); }
    friend constexpr Duration operator-(Duration a, Duration b) { return Duration(a.us_ - b.us_); }
    friend constexpr bool operator==(Duration a, Duration b) { return a.us_ == b.us_; }
    friend constexpr bool operator!=(Duration a, Duration b) { return a.us_ != b.us_; }

    friend std::ostream& operator<<(std::ostream& os, Duration d) { return os << d.us_ << "us"; }

private:
    constexpr explicit Duration(std::int64_t us) : us_(us) {}

    std::int64_t us_ = 0;
};

// stats customization points: durations are summarized in microseconds.
inline double to_scalar(const Duration& d) { return static_cast<double>(d.count_micros()); }

inline Duration from_scalar(double us, stats::type_tag<Duration>) {
    return Duration::micros(std::llround(us));
}

}  // namespace units
