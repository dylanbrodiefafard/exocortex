#pragma once

#include <memory>
#include <string>
#include <vector>

#include "audio/buffer.hpp"
#include "config/schema.hpp"
#include "pipeline/registry.hpp"

namespace tapeline {

// The settings a pipeline file may give before its first `[stage]`.
const std::vector<ParamSpec>& pipeline_settings();

// A chain of stages built from a pipeline file.
class Pipeline {
public:
    // Parses and validates a pipeline file against `registry`. Throws
    // ConfigError.
    static Pipeline from_text(const std::string& text, const StageRegistry& registry = builtin_registry());

    // Prepares every stage for a stream. Must be called before process();
    // throws StageError if a stage cannot handle the stream.
    void prepare(int sample_rate, int channels);

    // Runs the whole buffer through every stage, block_size() frames at a
    // time. The buffer must have the channel count given to prepare().
    void process(AudioBuffer& buffer);

    // Forgets all stream state, as if freshly prepared.
    void reset();

    std::size_t block_size() const { return block_size_; }
    const std::vector<std::string>& stage_names() const { return names_; }

private:
    std::vector<std::unique_ptr<Stage>> stages_;
    std::vector<std::string> names_;
    std::size_t block_size_ = 256;
    int channels_ = 0;
    bool prepared_ = false;
};

}  // namespace tapeline
