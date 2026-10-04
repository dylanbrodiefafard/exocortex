#include <cmath>
#include <vector>

#include "dsp/util.hpp"
#include "stages/stages.hpp"

namespace tapeline::stages {

namespace {

// One-pole low-pass filter: y[n] = y[n-1] + a * (x[n] - y[n-1]).
class Lowpass : public Stage {
public:
    explicit Lowpass(double cutoff_hz) : cutoff_hz_(cutoff_hz) {}

    void prepare(const StreamInfo& info) override {
        if (cutoff_hz_ >= info.sample_rate / 2.0) {
            throw StageError("lowpass", "cutoff_hz " + dsp::format_number(cutoff_hz_) +
                                            " must be below half the sample rate (" +
                                            dsp::format_number(info.sample_rate / 2.0) + ")");
        }
        a_ = static_cast<float>(1.0 - std::exp(-2.0 * dsp::kPi * cutoff_hz_ / info.sample_rate));
        state_.assign(static_cast<std::size_t>(info.channels), 0.0f);
    }

    void process(AudioBuffer& block) override {
        for (int c = 0; c < block.channels(); ++c) {
            float y = state_[static_cast<std::size_t>(c)];
            float* x = block.channel(c);
            for (std::size_t i = 0; i < block.frames(); ++i) {
                y += a_ * (x[i] - y);
                x[i] = y;
            }
            state_[static_cast<std::size_t>(c)] = y;
        }
    }

    void reset() override { std::fill(state_.begin(), state_.end(), 0.0f); }

private:
    double cutoff_hz_;
    float a_ = 1.0f;
    std::vector<float> state_;
};

}  // namespace

StageDescriptor lowpass_descriptor() {
    return StageDescriptor{
        "lowpass",
        "One-pole low-pass filter",
        {ParamSpec::number("cutoff_hz", 1000.0, 10.0, 20000.0)},
        [](const Params& p) { return std::make_unique<Lowpass>(p.number("cutoff_hz")); },
    };
}

}  // namespace tapeline::stages
