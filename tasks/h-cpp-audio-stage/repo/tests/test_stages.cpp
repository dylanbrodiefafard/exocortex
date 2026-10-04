#include <cmath>

#include "helpers.hpp"
#include "pipeline/stage.hpp"
#include "testing.hpp"

using namespace tapeline;

TEST(gain_scales_every_channel) {
    auto out = run_pipeline("[gain]\ndb = -20\n", {{1.0f, -0.5f}, {0.25f, 0.0f}});
    CHECK_NEAR(out[0][0], 0.1, 1e-6);
    CHECK_NEAR(out[0][1], -0.05, 1e-6);
    CHECK_NEAR(out[1][0], 0.025, 1e-6);
}

TEST(clip_hard_and_soft) {
    auto hard = run_pipeline("[clip]\nthreshold = 0.5\n", {{0.9f, -0.9f, 0.2f}});
    CHECK_NEAR(hard[0][0], 0.5, 1e-7);
    CHECK_NEAR(hard[0][1], -0.5, 1e-7);
    CHECK_NEAR(hard[0][2], 0.2, 1e-7);
    auto soft = run_pipeline("[clip]\nthreshold = 0.5\nmode = soft\n", {{0.9f}});
    CHECK_NEAR(soft[0][0], 0.5 * std::tanh(0.9 / 0.5), 1e-6);
}

TEST(fade_ramps_over_the_converted_length) {
    // 2.5 ms at 1000 Hz is 3 samples (rounded half up).
    auto out = run_pipeline("[fade]\nin_ms = 2.5\n", {constant(5, 1.0f)});
    CHECK_NEAR(out[0][0], 0.0, 1e-7);
    CHECK_NEAR(out[0][1], 1.0 / 3.0, 1e-6);
    CHECK_NEAR(out[0][2], 2.0 / 3.0, 1e-6);
    CHECK_NEAR(out[0][3], 1.0, 1e-7);
    CHECK_NEAR(out[0][4], 1.0, 1e-7);
}

TEST(fade_continues_across_blocks) {
    auto out = run_pipeline("block_size = 1\n[fade]\nin_ms = 4\n", {constant(5, 1.0f)});
    CHECK_NEAR(out[0][3], 0.75, 1e-6);
    CHECK_NEAR(out[0][4], 1.0, 1e-7);
}

TEST(lowpass_settles_to_dc) {
    auto out = run_pipeline("[lowpass]\ncutoff_hz = 100\n", {constant(200, 1.0f)});
    double a = 1.0 - std::exp(-2.0 * 3.14159265358979323846 * 100.0 / 1000.0);
    CHECK_NEAR(out[0][0], a, 1e-6);
    CHECK_NEAR(out[0][1], a + a * (1.0 - a), 1e-6);
    CHECK_NEAR(out[0][199], 1.0, 1e-5);
}

TEST(lowpass_rejects_cutoff_above_nyquist) {
    Pipeline p = Pipeline::from_text("[lowpass]\ncutoff_hz = 600\n");
    CHECK_THROWS(p.prepare(1000, 1), StageError,
                 "stage 'lowpass': cutoff_hz 600 must be below half the sample rate (500)");
}

TEST(dcblock_removes_offset) {
    auto out = run_pipeline("[dcblock]\nr = 0.9\n", {constant(100, 0.5f)});
    CHECK_NEAR(out[0][0], 0.5, 1e-7);
    CHECK_NEAR(out[0][1], 0.45, 1e-6);
    CHECK(std::fabs(out[0][99]) < 1e-4);
}

TEST(gate_holds_then_silences) {
    // hold_ms = 2 at 1000 Hz is 2 samples: the 3rd quiet sample in a row is muted.
    std::vector<float> in = {0.5f, 0.001f, 0.001f, 0.001f, 0.001f, 0.5f, 0.001f};
    auto out = run_pipeline("[gate]\nthreshold_db = -20\nhold_ms = 2\n", {in});
    std::vector<float> want = {0.5f, 0.001f, 0.001f, 0.0f, 0.0f, 0.5f, 0.001f};
    CHECK(out[0] == want);
}

TEST(pan_is_constant_power) {
    auto centre = run_pipeline("[pan]\n", {{1.0f}, {1.0f}});
    CHECK_NEAR(centre[0][0], 1.0, 1e-6);
    CHECK_NEAR(centre[1][0], 1.0, 1e-6);
    auto left = run_pipeline("[pan]\nposition = -1\n", {{1.0f}, {1.0f}});
    CHECK_NEAR(left[0][0], std::sqrt(2.0), 1e-6);
    CHECK_NEAR(left[1][0], 0.0, 1e-6);
}

TEST(pan_needs_stereo) {
    Pipeline p = Pipeline::from_text("[pan]\n");
    CHECK_THROWS(p.prepare(1000, 1), StageError, "stage 'pan': needs 2 channels, got 1");
}
