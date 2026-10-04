#include "dsp/util.hpp"
#include "testing.hpp"

using namespace tapeline::dsp;

TEST(ms_to_samples_rounds_to_nearest_halves_up) {
    CHECK_EQ(ms_to_samples(10.0, 48000), std::size_t{480});
    CHECK_EQ(ms_to_samples(2.5, 1000), std::size_t{3});
    CHECK_EQ(ms_to_samples(2.4, 1000), std::size_t{2});
    CHECK_EQ(ms_to_samples(0.01, 44100), std::size_t{0});
    CHECK_EQ(ms_to_samples(0.0, 44100), std::size_t{0});
    CHECK_EQ(ms_to_samples(-5.0, 44100), std::size_t{0});
}

TEST(decibels) {
    CHECK_NEAR(db_to_gain(0.0), 1.0, 1e-12);
    CHECK_NEAR(db_to_gain(-20.0), 0.1, 1e-12);
    CHECK_NEAR(gain_to_db(10.0), 20.0, 1e-12);
    CHECK(std::isinf(gain_to_db(0.0)));
}

TEST(format_number_drops_trailing_zeros) {
    CHECK_EQ(format_number(250.0), std::string("250"));
    CHECK_EQ(format_number(-60.0), std::string("-60"));
    CHECK_EQ(format_number(0.95), std::string("0.95"));
    CHECK_EQ(format_number(0.9999), std::string("0.9999"));
    CHECK_EQ(format_number(1.0 / 3.0), std::string("0.333333"));
}
