#include "audio/wav.hpp"

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace tapeline {

namespace {

std::uint32_t read_u32(const unsigned char* p) {
    return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

std::uint16_t read_u16(const unsigned char* p) {
    return static_cast<std::uint16_t>(p[0] | (p[1] << 8));
}

void put_u32(std::ostream& out, std::uint32_t v) {
    char b[4] = {static_cast<char>(v & 0xff), static_cast<char>((v >> 8) & 0xff),
                 static_cast<char>((v >> 16) & 0xff), static_cast<char>((v >> 24) & 0xff)};
    out.write(b, 4);
}

void put_u16(std::ostream& out, std::uint16_t v) {
    char b[2] = {static_cast<char>(v & 0xff), static_cast<char>((v >> 8) & 0xff)};
    out.write(b, 2);
}

}  // namespace

WavData read_wav(std::istream& in) {
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (bytes.size() < 12 || std::string(bytes.begin(), bytes.begin() + 4) != "RIFF" ||
        std::string(bytes.begin() + 8, bytes.begin() + 12) != "WAVE") {
        throw WavError("not a RIFF/WAVE file");
    }
    int channels = 0, rate = 0, bits = 0;
    const unsigned char* data = nullptr;
    std::size_t data_size = 0;
    std::size_t pos = 12;
    while (pos + 8 <= bytes.size()) {
        std::string id(bytes.begin() + static_cast<long>(pos), bytes.begin() + static_cast<long>(pos) + 4);
        std::size_t size = read_u32(&bytes[pos + 4]);
        std::size_t body = pos + 8;
        if (body + size > bytes.size()) throw WavError("truncated '" + id + "' chunk");
        if (id == "fmt ") {
            if (size < 16) throw WavError("'fmt ' chunk is too short");
            if (read_u16(&bytes[body]) != 1) throw WavError("unsupported format: only PCM is supported");
            channels = read_u16(&bytes[body + 2]);
            rate = static_cast<int>(read_u32(&bytes[body + 4]));
            bits = read_u16(&bytes[body + 14]);
        } else if (id == "data") {
            data = &bytes[body];
            data_size = size;
        }
        pos = body + size + (size & 1);
    }
    if (channels == 0) throw WavError("missing 'fmt ' chunk");
    if (data == nullptr) throw WavError("missing 'data' chunk");
    if (bits != 16) throw WavError("unsupported format: only 16-bit samples are supported");
    std::size_t frames = data_size / (2 * static_cast<std::size_t>(channels));
    WavData wav;
    wav.sample_rate = rate;
    wav.audio = AudioBuffer(channels, frames);
    for (std::size_t f = 0; f < frames; ++f) {
        for (int c = 0; c < channels; ++c) {
            auto raw = static_cast<std::int16_t>(read_u16(data + 2 * (f * static_cast<std::size_t>(channels) + static_cast<std::size_t>(c))));
            wav.audio.at(c, f) = static_cast<float>(raw) / 32768.0f;
        }
    }
    return wav;
}

void write_wav(std::ostream& out, const WavData& wav) {
    const auto channels = static_cast<std::uint16_t>(wav.audio.channels());
    const auto frames = static_cast<std::uint32_t>(wav.audio.frames());
    const std::uint32_t data_size = frames * channels * 2u;
    out.write("RIFF", 4);
    put_u32(out, 36 + data_size);
    out.write("WAVEfmt ", 8);
    put_u32(out, 16);
    put_u16(out, 1);
    put_u16(out, channels);
    put_u32(out, static_cast<std::uint32_t>(wav.sample_rate));
    put_u32(out, static_cast<std::uint32_t>(wav.sample_rate) * channels * 2u);
    put_u16(out, static_cast<std::uint16_t>(channels * 2));
    put_u16(out, 16);
    out.write("data", 4);
    put_u32(out, data_size);
    for (std::uint32_t f = 0; f < frames; ++f) {
        for (int c = 0; c < channels; ++c) {
            double s = std::round(static_cast<double>(wav.audio.at(c, f)) * 32768.0);
            s = s > 32767.0 ? 32767.0 : (s < -32768.0 ? -32768.0 : s);
            put_u16(out, static_cast<std::uint16_t>(static_cast<std::int16_t>(s)));
        }
    }
}

}  // namespace tapeline
