#include "pipeline/pipeline.hpp"

#include <algorithm>
#include <stdexcept>

#include "config/error.hpp"
#include "config/parser.hpp"

namespace tapeline {

const std::vector<ParamSpec>& pipeline_settings() {
    static const std::vector<ParamSpec> specs = {
        ParamSpec::integer("block_size", 256, 1, 65536),
    };
    return specs;
}

Pipeline Pipeline::from_text(const std::string& text, const StageRegistry& registry) {
    PipelineText parsed = parse_pipeline_text(text);
    Pipeline p;
    Params settings = resolve_params("", pipeline_settings(), parsed.settings);
    p.block_size_ = static_cast<std::size_t>(settings.integer("block_size"));
    for (const auto& section : parsed.stages) {
        const StageDescriptor* d = registry.find(section.name);
        if (d == nullptr) throw ConfigError(section.line, "unknown stage '" + section.name + "'");
        Params params = resolve_params("stage '" + section.name + "'", d->params, section.params);
        p.stages_.push_back(d->create(params));
        p.names_.push_back(section.name);
    }
    return p;
}

void Pipeline::prepare(int sample_rate, int channels) {
    if (sample_rate <= 0 || channels <= 0) throw std::invalid_argument("prepare: bad stream format");
    StreamInfo info;
    info.sample_rate = sample_rate;
    info.channels = channels;
    info.max_block = block_size_;
    for (auto& s : stages_) s->prepare(info);
    channels_ = channels;
    prepared_ = true;
}

void Pipeline::process(AudioBuffer& buffer) {
    if (!prepared_) throw std::logic_error("process: pipeline not prepared");
    if (buffer.channels() != channels_) throw std::logic_error("process: channel count differs from prepare()");
    AudioBuffer block(channels_, block_size_);
    for (std::size_t start = 0; start < buffer.frames(); start += block_size_) {
        std::size_t n = std::min(block_size_, buffer.frames() - start);
        block.resize(n);
        block.copy_from(buffer, start, 0, n);
        for (auto& s : stages_) s->process(block);
        buffer.copy_from(block, 0, start, n);
    }
}

void Pipeline::reset() {
    for (auto& s : stages_) s->reset();
}

}  // namespace tapeline
