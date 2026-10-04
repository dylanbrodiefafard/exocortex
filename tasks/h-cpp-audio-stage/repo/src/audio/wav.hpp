#pragma once

#include <istream>
#include <ostream>
#include <stdexcept>

#include "audio/buffer.hpp"

namespace tapeline {

class WavError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct WavData {
    int sample_rate = 0;
    AudioBuffer audio;
};

// Reads a 16-bit PCM WAV file. Throws WavError.
WavData read_wav(std::istream& in);

// Writes 16-bit PCM. Samples outside [-1, 1] are clipped.
void write_wav(std::ostream& out, const WavData& wav);

}  // namespace tapeline
