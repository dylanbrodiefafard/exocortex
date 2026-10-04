#pragma once

#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "audio/buffer.hpp"
#include "config/schema.hpp"

namespace tapeline {

// A processing step. The pipeline calls prepare() once before any audio,
// then process() for consecutive blocks of the stream (each at most
// StreamInfo::max_block frames, and possibly shorter), and reset() to start
// a new stream. A stage that keeps state between samples must carry it
// across process() calls: the output must not depend on how the stream is
// split into blocks.
class Stage {
public:
    virtual ~Stage() = default;
    virtual void prepare(const StreamInfo& info) { (void)info; }
    virtual void process(AudioBuffer& block) = 0;
    virtual void reset() {}
};

// A stage that cannot work with the stream it was prepared for. what() is
// "stage '<name>': <message>".
class StageError : public std::runtime_error {
public:
    StageError(const std::string& stage, const std::string& message)
        : std::runtime_error("stage '" + stage + "': " + message) {}
};

// Everything the registry knows about a kind of stage.
struct StageDescriptor {
    // The name used in `[name]` headers.
    std::string name;
    // One line for `tapeline --list-stages`, no trailing period.
    std::string summary;
    // Parameters, in the order `tapeline --describe` lists them.
    std::vector<ParamSpec> params;
    // Builds a stage from validated parameters.
    std::function<std::unique_ptr<Stage>(const Params&)> create;
};

}  // namespace tapeline
