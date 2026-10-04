#include "dsp/util.hpp"
#include "stages/stages.hpp"

namespace tapeline::stages {

namespace {

// Linear fade-in from silence over the first `length_` frames of the stream.
class Fade : public Stage {
public:
    explicit Fade(double in_ms) : in_ms_(in_ms) {}

    void prepare(const StreamInfo& info) override {
        length_ = dsp::ms_to_samples(in_ms_, info.sample_rate);
        position_ = 0;
    }

    void process(AudioBuffer& block) override {
        for (std::size_t i = 0; i < block.frames() && position_ < length_; ++i, ++position_) {
            float g = static_cast<float>(static_cast<double>(position_) / static_cast<double>(length_));
            for (int c = 0; c < block.channels(); ++c) block.at(c, i) *= g;
        }
    }

    void reset() override { position_ = 0; }

private:
    double in_ms_;
    std::size_t length_ = 0;
    std::size_t position_ = 0;
};

}  // namespace

StageDescriptor fade_descriptor() {
    return StageDescriptor{
        "fade",
        "Fade the start of the stream in from silence",
        {ParamSpec::number("in_ms", 10.0, 0.0, 60000.0)},
        [](const Params& p) { return std::make_unique<Fade>(p.number("in_ms")); },
    };
}

}  // namespace tapeline::stages
