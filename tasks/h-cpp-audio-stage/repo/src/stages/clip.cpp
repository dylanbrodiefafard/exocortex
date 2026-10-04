#include <cmath>

#include "stages/stages.hpp"

namespace tapeline::stages {

namespace {

class Clip : public Stage {
public:
    Clip(double threshold, bool soft) : threshold_(static_cast<float>(threshold)), soft_(soft) {}

    void process(AudioBuffer& block) override {
        for (int c = 0; c < block.channels(); ++c) {
            float* x = block.channel(c);
            for (std::size_t i = 0; i < block.frames(); ++i) {
                if (soft_) {
                    x[i] = threshold_ * std::tanh(x[i] / threshold_);
                } else if (x[i] > threshold_) {
                    x[i] = threshold_;
                } else if (x[i] < -threshold_) {
                    x[i] = -threshold_;
                }
            }
        }
    }

private:
    float threshold_;
    bool soft_;
};

}  // namespace

StageDescriptor clip_descriptor() {
    return StageDescriptor{
        "clip",
        "Limit samples to a threshold, hard or soft",
        {
            ParamSpec::number("threshold", 1.0, 0.01, 1.0),
            ParamSpec::choice("mode", "hard", {"hard", "soft"}),
        },
        [](const Params& p) { return std::make_unique<Clip>(p.number("threshold"), p.choice("mode") == "soft"); },
    };
}

}  // namespace tapeline::stages
