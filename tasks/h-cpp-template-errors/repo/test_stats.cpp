#include <cmath>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <vector>

#include "duration.hpp"
#include "stats.hpp"

static int failures = 0;

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond \
                      << "\n";                                                   \
            ++failures;                                                          \
        }                                                                        \
    } while (0)

#define CHECK_EQ(a, b)                                                                 \
    do {                                                                               \
        const auto& va = (a);                                                          \
        const auto& vb = (b);                                                          \
        if (!(va == vb)) {                                                             \
            std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK_EQ failed: " #a " == " #b \
                      << " (" << va << " vs " << vb << ")\n";                          \
            ++failures;                                                                \
        }                                                                              \
    } while (0)

#define CHECK_NEAR(a, b, eps) CHECK(std::fabs((a) - (b)) <= (eps))

template <typename F>
static bool throws(F&& f) {
    try {
        f();
    } catch (const std::exception&) {
        return true;
    }
    return false;
}

static void test_integers() {
    std::vector<int> values{23, 4, 42, 15, 8, 16};
    stats::Summary<int> s(values.begin(), values.end());
    CHECK_EQ(s.count(), 6u);
    CHECK_EQ(s.sum(), 108);
    CHECK_EQ(s.min(), 4);
    CHECK_EQ(s.max(), 42);
    CHECK_EQ(s.mean(), 18);
    CHECK_EQ(s.median(), 16);  // 15.5 rounds to 16
    CHECK_EQ(s.quantile(0.0), 4);
    CHECK_EQ(s.quantile(1.0), 42);
    CHECK_NEAR(s.variance(), 910.0 / 6.0, 1e-9);
    CHECK_EQ(s.stddev(), 12);
}

static void test_doubles() {
    stats::Summary<double> s;
    for (double v : {2.5, 0.5, 1.0, 4.0}) s.add(v);
    CHECK_NEAR(s.sum(), 8.0, 1e-12);
    CHECK_NEAR(s.mean(), 2.0, 1e-12);
    CHECK_NEAR(s.median(), 1.75, 1e-12);
    CHECK_NEAR(s.quantile(0.25), 0.875, 1e-12);
    CHECK_NEAR(s.variance(), 1.875, 1e-12);
}

static void test_empty() {
    stats::Summary<double> s;
    CHECK(s.empty());
    CHECK_EQ(s.count(), 0u);
    CHECK(throws([&] { s.mean(); }));
    CHECK(throws([&] { s.min(); }));
    CHECK(throws([&] { s.median(); }));
    s.add(1.0);
    CHECK(throws([&] { s.quantile(1.5); }));
}

using units::Duration;

static std::vector<Duration> latencies() {
    return {Duration::millis(12), Duration::millis(7),   Duration::micros(30500),
            Duration::millis(9),  Duration::millis(120), Duration::micros(15250),
            Duration::millis(11), Duration::millis(8)};
}

static void test_durations() {
    const auto lat = latencies();
    stats::Summary<Duration> s(lat.begin(), lat.end());
    CHECK_EQ(s.count(), 8u);
    CHECK_EQ(s.sum(), Duration::micros(212750));
    CHECK_EQ(s.min(), Duration::millis(7));
    CHECK_EQ(s.max(), Duration::millis(120));
    CHECK_EQ(s.mean(), Duration::micros(26594));  // 26593.75us
    CHECK_EQ(s.median(), Duration::micros(11500));
    CHECK_EQ(s.quantile(0.9), Duration::micros(57350));  // 30500 + 0.3 * 89500
    CHECK_EQ(s.stddev(), Duration::micros(35993));
    CHECK_NEAR(s.variance(), 1295499023.4375, 1e-3);
}

static void test_duration_merge() {
    const auto lat = latencies();
    stats::Summary<Duration> all(lat.begin(), lat.end());
    stats::Summary<Duration> first(lat.begin(), lat.begin() + 3);
    stats::Summary<Duration> second(lat.begin() + 3, lat.end());
    first.merge(second);
    CHECK_EQ(first.count(), all.count());
    CHECK_EQ(first.sum(), all.sum());
    CHECK_EQ(first.min(), all.min());
    CHECK_EQ(first.max(), all.max());
    CHECK_EQ(first.mean(), all.mean());
    CHECK_EQ(first.median(), all.median());
    CHECK_NEAR(first.variance(), all.variance(), 1e-3);

    stats::Summary<Duration> empty;
    empty.merge(all);
    CHECK_EQ(empty.quantile(0.9), all.quantile(0.9));
}

int main() {
    test_integers();
    test_doubles();
    test_empty();
    test_durations();
    test_duration_merge();
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all tests passed\n";
    return EXIT_SUCCESS;
}
