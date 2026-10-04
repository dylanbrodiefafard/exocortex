#pragma once

#include <cstddef>
#include <vector>

namespace tapeline {

// Planar audio: one vector of samples per channel, all the same length.
// Samples are floats, nominally in [-1, 1].
class AudioBuffer {
public:
    AudioBuffer() = default;
    AudioBuffer(int channels, std::size_t frames);

    int channels() const { return static_cast<int>(data_.size()); }
    std::size_t frames() const { return data_.empty() ? 0 : data_[0].size(); }

    float* channel(int c) { return data_[static_cast<std::size_t>(c)].data(); }
    const float* channel(int c) const { return data_[static_cast<std::size_t>(c)].data(); }

    float& at(int c, std::size_t frame) { return data_[static_cast<std::size_t>(c)][frame]; }
    float at(int c, std::size_t frame) const { return data_[static_cast<std::size_t>(c)][frame]; }

    // Changes the number of frames; new frames are silent.
    void resize(std::size_t frames);

    // Copies `count` frames starting at `src_start` in `src` to `dst_start`
    // in this buffer. Both buffers must have the same channel count.
    void copy_from(const AudioBuffer& src, std::size_t src_start, std::size_t dst_start, std::size_t count);

    // Builds a buffer from per-channel sample lists (used by tests).
    static AudioBuffer from_channels(const std::vector<std::vector<float>>& channels);

    const std::vector<float>& samples(int c) const { return data_[static_cast<std::size_t>(c)]; }

private:
    std::vector<std::vector<float>> data_;
};

// What a stage needs to know about the stream before processing it.
struct StreamInfo {
    int sample_rate = 48000;
    int channels = 2;
    // The largest number of frames passed to Stage::process at once.
    std::size_t max_block = 256;
};

}  // namespace tapeline
