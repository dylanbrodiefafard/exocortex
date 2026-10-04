#pragma once

#include <vector>

namespace latency::stats {

// Arithmetic mean; 0 for an empty input.
template <typename T>
double mean(const std::vector<T>& values);

// Nearest-rank percentile (p in (0, 100]); throws std::invalid_argument for an
// empty input or p out of range.
template <typename T>
T percentile(std::vector<T> values, double p);

template <typename T>
T max_value(const std::vector<T>& values);

}  // namespace latency::stats
