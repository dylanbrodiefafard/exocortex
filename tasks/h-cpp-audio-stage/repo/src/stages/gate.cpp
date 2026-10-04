#include <algorithm>
#include <cmath>
#include <vector>

#include "dsp/util.hpp"
#include "stages/stages.hpp"

namespace tapeline::stages {

namespace {

// Silences a channel once it has stayed below the threshold for longer than
// the hold time.
class Gate : public Stage {
public:
    Gate(double threshold_db, double hold_ms)
        : threshold_(static_cast<float>(dsp::db_to_gain(threshold_db))), hold_ms_(hold_ms) {}

    void prepare(const StreamInfo& info) override {
        hold_ = dsp::ms_to_samples(hold_ms_, info.sample_rate);
        quiet_.assign(static_cast<std::size_t>(info.channels), 0);
    }

    void process(AudioBuffer& block) override {
        for (int c = 0; c < block.channels(); ++c) {
            std::size_t& quiet = quiet_[static_cast<std::size_t>(c)];
            float* x = block.channel(c);
            for (std::size_t i = 0; i < block.frames(); ++i) {
                if (std::fabs(x[i]) >= threshold_) {
                    quiet = 0;
                } else if (++quiet > hold_) {
                    x[i] = 0.0f;
                }
            }
        }
    }

    void reset() override { std::fill(quiet_.begin(), quiet_.end(), 0); }

private:
    float threshold_;
    double hold_ms_;
    std::size_t hold_ = 0;
    std::vector<std::size_t> quiet_;
};

}  // namespace

StageDescriptor gate_descriptor() {
    return StageDescriptor{
        "gate",
        "Silence quiet passages after a hold time",
        {
            ParamSpec::number("threshold_db", -50.0, -100.0, 0.0),
            ParamSpec::number("hold_ms", 50.0, 0.0, 5000.0),
        },
        [](const Params& p) { return std::make_unique<Gate>(p.number("threshold_db"), p.number("hold_ms")); },
    };
}

}  // namespace tapeline::stages
