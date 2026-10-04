#include "audio/buffer.hpp"

#include <stdexcept>

namespace tapeline {

AudioBuffer::AudioBuffer(int channels, std::size_t frames)
    : data_(static_cast<std::size_t>(channels), std::vector<float>(frames, 0.0f)) {}

void AudioBuffer::resize(std::size_t frames) {
    for (auto& ch : data_) ch.resize(frames, 0.0f);
}

void AudioBuffer::copy_from(const AudioBuffer& src, std::size_t src_start, std::size_t dst_start,
                            std::size_t count) {
    if (src.channels() != channels()) throw std::logic_error("copy_from: channel count mismatch");
    if (src_start + count > src.frames() || dst_start + count > frames()) {
        throw std::out_of_range("copy_from: range out of bounds");
    }
    for (int c = 0; c < channels(); ++c) {
        const float* in = src.channel(c) + src_start;
        float* out = channel(c) + dst_start;
        for (std::size_t i = 0; i < count; ++i) out[i] = in[i];
    }
}

AudioBuffer AudioBuffer::from_channels(const std::vector<std::vector<float>>& channels) {
    AudioBuffer buf;
    buf.data_ = channels;
    for (const auto& ch : buf.data_) {
        if (ch.size() != buf.data_[0].size()) throw std::invalid_argument("from_channels: ragged channels");
    }
    return buf;
}

}  // namespace tapeline
