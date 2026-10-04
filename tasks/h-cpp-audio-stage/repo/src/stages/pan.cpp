#include <cmath>

#include "dsp/util.hpp"
#include "stages/stages.hpp"

namespace tapeline::stages {

namespace {

// Constant-power panning of a stereo stream.
class Pan : public Stage {
public:
    explicit Pan(double position) {
        double angle = (position + 1.0) * dsp::kPi / 4.0;
        left_ = static_cast<float>(std::cos(angle) * std::sqrt(2.0));
        right_ = static_cast<float>(std::sin(angle) * std::sqrt(2.0));
    }

    void prepare(const StreamInfo& info) override {
        if (info.channels != 2) {
            throw StageError("pan", "needs 2 channels, got " + std::to_string(info.channels));
        }
    }

    void process(AudioBuffer& block) override {
        float* l = block.channel(0);
        float* r = block.channel(1);
        for (std::size_t i = 0; i < block.frames(); ++i) {
            l[i] *= left_;
            r[i] *= right_;
        }
    }

private:
    float left_ = 1.0f;
    float right_ = 1.0f;
};

}  // namespace

StageDescriptor pan_descriptor() {
    return StageDescriptor{
        "pan",
        "Move a stereo stream left or right",
        {ParamSpec::number("position", 0.0, -1.0, 1.0)},
        [](const Params& p) { return std::make_unique<Pan>(p.number("position")); },
    };
}

}  // namespace tapeline::stages
