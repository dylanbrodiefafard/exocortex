#pragma once

#include <string>
#include <vector>

namespace tapeline {

// One `key = value` line.
struct RawParam {
    std::string key;
    std::string value;
    int line = 0;
};

// A `[stage]` header and the lines under it.
struct StageSection {
    std::string name;
    int line = 0;
    std::vector<RawParam> params;
};

// The syntax of a pipeline file, before any validation.
struct PipelineText {
    // Settings before the first `[stage]` header.
    std::vector<RawParam> settings;
    // Stages in file order. A stage may appear more than once.
    std::vector<StageSection> stages;
};

// Splits a pipeline file into settings and stage sections. Only syntax is
// checked here; names and values are validated against the schemas later.
// Throws ConfigError.
PipelineText parse_pipeline_text(const std::string& text);

}  // namespace tapeline
