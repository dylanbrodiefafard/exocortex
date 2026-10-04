#pragma once

#include <cstddef>
#include <string>

namespace tapeline::dsp {

constexpr double kPi = 3.14159265358979323846;

// Converts a duration in milliseconds to a whole number of samples at
// `sample_rate`, rounding to the nearest sample (halves round up). Every
// stage with a time parameter converts it with this function, so that all
// stages agree on how long "10 ms" is.
std::size_t ms_to_samples(double ms, int sample_rate);

// Decibels to a linear amplitude factor: 0 dB is 1.0, -6 dB about 0.5.
double db_to_gain(double db);

// Linear amplitude to decibels; silence is -infinity.
double gain_to_db(double gain);

double clamp(double x, double lo, double hi);

// Formats a number the way messages and listings show it: integers without
// a decimal point (250, -60), others with up to 6 significant digits (0.95).
std::string format_number(double x);

}  // namespace tapeline::dsp
