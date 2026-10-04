#include "latency/stats.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <stdexcept>

namespace latency::stats {

template <typename T>
double mean(const std::vector<T>& values) {
    if (values.empty()) {
        return 0.0;
    }
    double sum = 0.0;
    for (const T& v : values) {
        sum += static_cast<double>(v);
    }
    return sum / static_cast<double>(values.size());
}

template <typename T>
T percentile(std::vector<T> values, double p) {
    if (values.empty()) {
        throw std::invalid_argument("percentile of empty set");
    }
    if (!(p > 0.0 && p <= 100.0)) {
        throw std::invalid_argument("percentile out of range");
    }
    std::sort(values.begin(), values.end());
    auto rank = static_cast<size_t>(std::ceil(p * static_cast<double>(values.size()) / 100.0));
    return values[std::max<size_t>(rank, 1) - 1];
}

template <typename T>
T max_value(const std::vector<T>& values) {
    if (values.empty()) {
        throw std::invalid_argument("max of empty set");
    }
    return *std::max_element(values.begin(), values.end());
}

template double mean<int>(const std::vector<int>&);
template double mean<double>(const std::vector<double>&);
template int percentile<int>(std::vector<int>, double);
template double percentile<double>(std::vector<double>, double);
template int max_value<int>(const std::vector<int>&);
template double max_value<double>(const std::vector<double>&);
template long max_value<long>(const std::vector<long>&);

}  // namespace latency::stats
