#include <sstream>

#include "app/cli.hpp"
#include "config/error.hpp"
#include "helpers.hpp"
#include "pipeline/registry.hpp"
#include "testing.hpp"

using namespace tapeline;

namespace {

void check_samples(const std::vector<float>& got, const std::vector<float>& want, const char* what) {
    if (got.size() != want.size()) {
        testing::fail(__FILE__, __LINE__, std::string(what) + ": wrong length");
        return;
    }
    for (std::size_t i = 0; i < got.size(); ++i) {
        if (std::fabs(got[i] - want[i]) > 1e-6) {
            testing::fail(__FILE__, __LINE__,
                          std::string(what) + ": sample " + std::to_string(i) + " is " + std::to_string(got[i]) +
                              ", want " + std::to_string(want[i]));
            return;
        }
    }
}

std::vector<float> wobble(std::size_t n, int seed) {
    std::vector<float> v;
    for (std::size_t i = 0; i < n; ++i) {
        v.push_back(static_cast<float>(static_cast<int>((i * 37 + static_cast<std::size_t>(seed) * 11) % 23) - 11) / 16.0f);
    }
    return v;
}

}  // namespace

TEST(echo_impulse_response) {
    auto out = run_pipeline("[echo]\ndelay_ms = 3\nfeedback = 0.5\nmix = 1\n", {impulse(12)});
    check_samples(out[0], {1, 0, 0, 1, 0, 0, 0.5f, 0, 0, 0.25f, 0, 0}, "impulse");
}

TEST(echo_mix_and_feedback) {
    auto out = run_pipeline("[echo]\ndelay_ms = 2\nfeedback = 0.25\nmix = 0.5\n", {{1, 1, 0, 0, 0, 0, 0}});
    // w = 1, 1, 0.25, 0.25, 0.0625, 0.0625, ...; y[n] = x[n] + 0.5 * w[n-2]
    check_samples(out[0], {1, 1, 0.5f, 0.5f, 0.125f, 0.125f, 0.03125f}, "mix");
    auto dry = run_pipeline("[echo]\ndelay_ms = 2\nmix = 0\n", {{0.5f, -0.25f, 1, 0}});
    check_samples(dry[0], {0.5f, -0.25f, 1, 0}, "mix 0");
    auto no_feedback = run_pipeline("[echo]\ndelay_ms = 1\nfeedback = 0\nmix = 1\n", {impulse(4)});
    check_samples(no_feedback[0], {1, 1, 0, 0}, "feedback 0");
}

TEST(echo_defaults) {
    auto out = run_pipeline("[echo]\n", {impulse(760)});
    CHECK_NEAR(out[0][0], 1.0, 1e-7);
    CHECK_NEAR(out[0][249], 0.0, 1e-7);
    CHECK_NEAR(out[0][250], 0.5, 1e-6);
    CHECK_NEAR(out[0][500], 0.2, 1e-6);
    CHECK_NEAR(out[0][750], 0.08, 1e-6);
    CHECK_NEAR(out[0][751], 0.0, 1e-7);
}

TEST(echo_delay_uses_the_shared_time_conversion) {
    auto a = run_pipeline("[echo]\ndelay_ms = 2.5\nfeedback = 0\nmix = 1\n", {impulse(6)});
    check_samples(a[0], {1, 0, 0, 1, 0, 0}, "2.5 ms at 1000 Hz");
    auto b = run_pipeline("[echo]\ndelay_ms = 2.4\nfeedback = 0\nmix = 1\n", {impulse(6)});
    check_samples(b[0], {1, 0, 1, 0, 0, 0}, "2.4 ms at 1000 Hz");
    auto c = run_pipeline("[echo]\ndelay_ms = 10\nfeedback = 0\nmix = 1\n", {impulse(500)}, 44100);
    CHECK_NEAR(c[0][441], 1.0, 1e-7);
    CHECK_NEAR(c[0][440], 0.0, 1e-7);
}

TEST(echo_delay_is_at_least_one_sample) {
    auto out = run_pipeline("[echo]\ndelay_ms = 1\nfeedback = 0.5\nmix = 1\n", {impulse(4)}, 100);
    check_samples(out[0], {1, 1, 0.5f, 0.25f}, "1 ms at 100 Hz");
}

TEST(echo_channels_are_independent) {
    auto out = run_pipeline("[echo]\ndelay_ms = 2\nfeedback = 0.5\nmix = 1\n", {impulse(6), impulse(6, 1)});
    check_samples(out[0], {1, 0, 1, 0, 0.5f, 0}, "left");
    check_samples(out[1], {0, 1, 0, 1, 0, 0.5f}, "right");
}

TEST(echo_output_does_not_depend_on_block_size) {
    const std::string stage = "[echo]\ndelay_ms = 5\nfeedback = 0.6\nmix = 0.7\n";
    std::vector<std::vector<float>> in = {wobble(97, 1), wobble(97, 2), wobble(97, 3)};
    auto whole = run_pipeline("block_size = 256\n" + stage, in);
    for (int bs : {1, 2, 3, 4, 5, 6, 64}) {
        auto split = run_pipeline("block_size = " + std::to_string(bs) + "\n" + stage, in);
        for (int c = 0; c < 3; ++c) check_samples(split[static_cast<std::size_t>(c)], whole[static_cast<std::size_t>(c)], "block size");
    }
    auto longer = run_pipeline("block_size = 4\n[echo]\ndelay_ms = 30\nfeedback = 0\nmix = 1\n", {impulse(40)});
    CHECK_NEAR(longer[0][30], 1.0, 1e-7);
}

TEST(echo_reset_clears_the_delay_line) {
    Pipeline p = Pipeline::from_text("[echo]\ndelay_ms = 3\nfeedback = 0.5\nmix = 1\n");
    p.prepare(1000, 1);
    AudioBuffer a = AudioBuffer::from_channels({{1, 0, 0, 0, 0}});
    p.process(a);
    p.reset();
    AudioBuffer b = AudioBuffer::from_channels({{0, 0, 0, 0, 0}});
    p.process(b);
    check_samples(b.samples(0), {0, 0, 0, 0, 0}, "after reset");
    AudioBuffer c = AudioBuffer::from_channels({{0, 0, 0, 0, 0}});
    p.process(c);
    check_samples(c.samples(0), {0, 0, 0, 0, 0}, "still silent");
}

TEST(echo_state_carries_across_process_calls) {
    Pipeline p = Pipeline::from_text("[echo]\ndelay_ms = 3\nfeedback = 0.5\nmix = 1\n");
    p.prepare(1000, 1);
    AudioBuffer a = AudioBuffer::from_channels({{1, 0}});
    p.process(a);
    AudioBuffer b = AudioBuffer::from_channels({{0, 0, 0, 0, 0}});
    p.process(b);
    check_samples(b.samples(0), {0, 1, 0, 0, 0.5f}, "second call");
}

TEST(echo_parameters_are_validated) {
    CHECK_THROWS(Pipeline::from_text("[echo]\nfeedback = 1.2\n"), ConfigError,
                 "line 2: stage 'echo': parameter 'feedback' must be between 0 and 0.95, got '1.2'");
    CHECK_THROWS(Pipeline::from_text("[gain]\n[echo]\n\ndelay_ms = 0\n"), ConfigError,
                 "line 4: stage 'echo': parameter 'delay_ms' must be between 1 and 2000, got '0'");
    CHECK_THROWS(Pipeline::from_text("[echo]\nmix = 1.5\n"), ConfigError,
                 "line 2: stage 'echo': parameter 'mix' must be between 0 and 1, got '1.5'");
    CHECK_THROWS(Pipeline::from_text("[echo]\nmix = lots\n"), ConfigError,
                 "line 2: stage 'echo': parameter 'mix' must be a number, got 'lots'");
    CHECK_THROWS(Pipeline::from_text("[echo]\ntime = 3\n"), ConfigError,
                 "line 2: stage 'echo': unknown parameter 'time'");
}

TEST(echo_is_registered) {
    const StageDescriptor* d = builtin_registry().find("echo");
    CHECK(d != nullptr);
    if (d == nullptr) return;
    CHECK_EQ(d->summary, std::string("Repeat the signal after a delay, with feedback"));
    CHECK_EQ(d->params.size(), std::size_t{3});
}

TEST(echo_in_cli_listings) {
    std::ostringstream out, err;
    CHECK_EQ(run_cli({"--list-stages"}, out, err), 0);
    CHECK(out.str().find("\necho       Repeat the signal after a delay, with feedback\n") != std::string::npos);
    std::ostringstream dout, derr;
    CHECK_EQ(run_cli({"--describe", "echo"}, dout, derr), 0);
    CHECK_EQ(dout.str(), std::string("echo: Repeat the signal after a delay, with feedback\n"
                                     "  delay_ms      float  default 250, range 1 to 2000\n"
                                     "  feedback      float  default 0.4, range 0 to 0.95\n"
                                     "  mix           float  default 0.5, range 0 to 1\n"));
}
