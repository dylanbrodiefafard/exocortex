#include "dsp/util.hpp"

#include <cmath>
#include <cstdio>
#include <limits>

namespace tapeline::dsp {

std::size_t ms_to_samples(double ms, int sample_rate) {
    if (ms <= 0.0 || sample_rate <= 0) return 0;
    return static_cast<std::size_t>(std::floor(ms * sample_rate / 1000.0 + 0.5));
}

double db_to_gain(double db) { return std::pow(10.0, db / 20.0); }

double gain_to_db(double gain) {
    if (gain <= 0.0) return -std::numeric_limits<double>::infinity();
    return 20.0 * std::log10(gain);
}

double clamp(double x, double lo, double hi) { return x < lo ? lo : (x > hi ? hi : x); }

std::string format_number(double x) {
    char buf[64];
    if (std::isfinite(x) && x == std::floor(x) && std::fabs(x) < 1e15) {
        std::snprintf(buf, sizeof buf, "%.0f", x);
    } else {
        std::snprintf(buf, sizeof buf, "%.6g", x);
    }
    return buf;
}

}  // namespace tapeline::dsp
