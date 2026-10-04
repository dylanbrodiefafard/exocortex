#pragma once

// stats::Summary<T> collects running summary statistics (count, sum, min, max,
// mean, variance, standard deviation) and exact quantiles over a stream of
// values of type T.
//
// Requirements on T:
//   * T is copyable, and a value-initialized T{} is the zero value.
//   * `a + b` yields a T.
//   * `a < b` is a strict weak ordering.
//   * Conversion to and from double, used for mean, variance and quantile
//     interpolation, goes through two customization points:
//
//         double to_scalar(const T&);
//         T      from_scalar(double, stats::type_tag<T>);
//
//     They are built in for arithmetic types. For any other type, declare
//     them in the namespace that declares T; they are found by
//     argument-dependent lookup.
//
// Nothing else is required of T.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace stats {

template <typename T>
struct type_tag {};

template <typename T, std::enable_if_t<std::is_arithmetic_v<T>, int> = 0>
double to_scalar(T value) {
    return static_cast<double>(value);
}

template <typename T, std::enable_if_t<std::is_arithmetic_v<T>, int> = 0>
T from_scalar(double value, type_tag<T>) {
    if constexpr (std::is_integral_v<T>) {
        return static_cast<T>(std::llround(value));
    } else {
        return static_cast<T>(value);
    }
}

template <typename T>
class Summary {
public:
    Summary() = default;

    template <typename It>
    Summary(It first, It last) {
        for (; first != last; ++first) add(*first);
    }

    void add(const T& value) {
        if (count_ == 0) {
            min_ = value;
            max_ = value;
        } else {
            min_ = std::min(min_, value);
            max_ = std::max(max_, value);
        }
        sum_ += value;
        ++count_;
        // Welford's online update, in scalar space.
        const double x = stats::to_scalar(value);
        const double delta = x - mean_;
        mean_ += delta / static_cast<double>(count_);
        m2_ += delta * (x - mean_);
        sample_.push_back(value);
    }

    // Combines another summary into this one, as if all of its values had
    // been added here.
    void merge(const Summary& other) {
        if (other.count_ == 0) return;
        if (count_ == 0) {
            *this = other;
            return;
        }
        min_ = std::min(min_, other.min_);
        max_ = std::max(max_, other.max_);
        sum_ += other.sum_;
        const double n_a = static_cast<double>(count_);
        const double n_b = static_cast<double>(other.count_);
        const double n = n_a + n_b;
        const double delta = other.mean_ - mean_;
        mean_ += delta * n_b / n;
        m2_ += other.m2_ + delta * delta * n_a * n_b / n;
        count_ += other.count_;
        sample_.insert(sample_.end(), other.sample_.begin(), other.sample_.end());
    }

    std::size_t count() const { return count_; }
    bool empty() const { return count_ == 0; }
    T sum() const { return sum_; }
    T min() const { return require_nonempty(), min_; }
    T max() const { return require_nonempty(), max_; }
    T mean() const { return require_nonempty(), stats::from_scalar(mean_, type_tag<T>{}); }

    // Population variance, in squared scalar units.
    double variance() const {
        require_nonempty();
        return m2_ / static_cast<double>(count_);
    }

    T stddev() const { return stats::from_scalar(std::sqrt(variance()), type_tag<T>{}); }

    // Linear-interpolated quantile, q in [0, 1]. quantile(0.5) is the median.
    T quantile(double q) const {
        require_nonempty();
        if (q < 0.0 || q > 1.0) throw std::domain_error("quantile out of range");
        std::vector<T> sorted = sample_;
        std::sort(sorted.begin(), sorted.end());
        const double pos = q * static_cast<double>(sorted.size() - 1);
        const std::size_t lo = static_cast<std::size_t>(std::floor(pos));
        const std::size_t hi = static_cast<std::size_t>(std::ceil(pos));
        if (lo == hi) return sorted[lo];
        const double a = stats::to_scalar(sorted[lo]);
        const double b = stats::to_scalar(sorted[hi]);
        return stats::from_scalar(a + (b - a) * (pos - static_cast<double>(lo)), type_tag<T>{});
    }

    T median() const { return quantile(0.5); }

private:
    void require_nonempty() const {
        if (count_ == 0) throw std::logic_error("empty summary");
    }

    std::size_t count_ = 0;
    T sum_{};
    T min_{};
    T max_{};
    double mean_ = 0.0;
    double m2_ = 0.0;
    std::vector<T> sample_;
};

}  // namespace stats
