#include "dsp/util.hpp"
#include "stages/stages.hpp"

namespace tapeline::stages {

namespace {

class Gain : public Stage {
public:
    explicit Gain(double db) : factor_(static_cast<float>(dsp::db_to_gain(db))) {}

    void process(AudioBuffer& block) override {
        for (int c = 0; c < block.channels(); ++c) {
            float* x = block.channel(c);
            for (std::size_t i = 0; i < block.frames(); ++i) x[i] *= factor_;
        }
    }

private:
    float factor_;
};

}  // namespace

StageDescriptor gain_descriptor() {
    return StageDescriptor{
        "gain",
        "Change the level by a number of decibels",
        {ParamSpec::number("db", 0.0, -60.0, 24.0)},
        [](const Params& p) { return std::make_unique<Gain>(p.number("db")); },
    };
}

}  // namespace tapeline::stages
