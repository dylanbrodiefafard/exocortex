#pragma once

#include <string>
#include <vector>

#include "audio/buffer.hpp"
#include "pipeline/pipeline.hpp"

// Runs `samples` (one vector per channel) through a pipeline built from
// `config` at `sample_rate`, returning the output channels.
inline std::vector<std::vector<float>> run_pipeline(const std::string& config,
                                                    const std::vector<std::vector<float>>& samples,
                                                    int sample_rate = 1000) {
    tapeline::Pipeline p = tapeline::Pipeline::from_text(config);
    tapeline::AudioBuffer buf = tapeline::AudioBuffer::from_channels(samples);
    p.prepare(sample_rate, buf.channels());
    p.process(buf);
    std::vector<std::vector<float>> out;
    for (int c = 0; c < buf.channels(); ++c) out.push_back(buf.samples(c));
    return out;
}

inline std::vector<float> impulse(std::size_t n, std::size_t at = 0) {
    std::vector<float> v(n, 0.0f);
    v[at] = 1.0f;
    return v;
}

inline std::vector<float> constant(std::size_t n, float value) { return std::vector<float>(n, value); }
