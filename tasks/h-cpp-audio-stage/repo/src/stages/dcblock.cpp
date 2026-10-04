#include <algorithm>
#include <vector>

#include "stages/stages.hpp"

namespace tapeline::stages {

namespace {

// DC blocker: y[n] = x[n] - x[n-1] + r * y[n-1].
class DcBlock : public Stage {
public:
    explicit DcBlock(double r) : r_(static_cast<float>(r)) {}

    void prepare(const StreamInfo& info) override {
        prev_x_.assign(static_cast<std::size_t>(info.channels), 0.0f);
        prev_y_.assign(static_cast<std::size_t>(info.channels), 0.0f);
    }

    void process(AudioBuffer& block) override {
        for (int c = 0; c < block.channels(); ++c) {
            auto ci = static_cast<std::size_t>(c);
            float* x = block.channel(c);
            for (std::size_t i = 0; i < block.frames(); ++i) {
                float y = x[i] - prev_x_[ci] + r_ * prev_y_[ci];
                prev_x_[ci] = x[i];
                prev_y_[ci] = y;
                x[i] = y;
            }
        }
    }

    void reset() override {
        std::fill(prev_x_.begin(), prev_x_.end(), 0.0f);
        std::fill(prev_y_.begin(), prev_y_.end(), 0.0f);
    }

private:
    float r_;
    std::vector<float> prev_x_, prev_y_;
};

}  // namespace

StageDescriptor dcblock_descriptor() {
    return StageDescriptor{
        "dcblock",
        "Remove DC offset",
        {ParamSpec::number("r", 0.995, 0.9, 0.9999)},
        [](const Params& p) { return std::make_unique<DcBlock>(p.number("r")); },
    };
}

}  // namespace tapeline::stages
