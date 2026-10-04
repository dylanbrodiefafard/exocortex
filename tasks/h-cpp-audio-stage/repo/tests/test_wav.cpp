#include <sstream>

#include "audio/wav.hpp"
#include "testing.hpp"

using namespace tapeline;

TEST(wav_round_trip) {
    WavData wav;
    wav.sample_rate = 22050;
    wav.audio = AudioBuffer::from_channels({{0.0f, 0.5f, -0.5f, 1.5f}, {0.25f, -1.0f, 0.0f, -2.0f}});
    std::stringstream buf;
    write_wav(buf, wav);
    WavData back = read_wav(buf);
    CHECK_EQ(back.sample_rate, 22050);
    CHECK_EQ(back.audio.channels(), 2);
    CHECK_EQ(back.audio.frames(), std::size_t{4});
    CHECK_NEAR(back.audio.at(0, 1), 0.5, 1e-4);
    CHECK_NEAR(back.audio.at(0, 3), 32767.0 / 32768.0, 1e-6);
    CHECK_NEAR(back.audio.at(1, 1), -1.0, 1e-6);
    CHECK_NEAR(back.audio.at(1, 3), -1.0, 1e-6);
}

TEST(wav_rejects_other_files) {
    std::stringstream junk("hello world, not audio");
    CHECK_THROWS(read_wav(junk), WavError, "not a RIFF/WAVE file");
}
