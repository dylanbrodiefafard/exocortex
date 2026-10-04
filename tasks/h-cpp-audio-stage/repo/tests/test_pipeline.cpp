#include "config/error.hpp"
#include "helpers.hpp"
#include "pipeline/pipeline.hpp"
#include "testing.hpp"

using namespace tapeline;

TEST(stages_run_in_file_order) {
    auto a = run_pipeline("[gain]\ndb = 6\n[clip]\nthreshold = 0.5\n", {{0.4f}});
    CHECK_NEAR(a[0][0], 0.5, 1e-7);
    auto b = run_pipeline("[clip]\nthreshold = 0.5\n[gain]\ndb = 6\n", {{0.4f}});
    CHECK_NEAR(b[0][0], 0.4 * std::pow(10.0, 6.0 / 20.0), 1e-6);
}

TEST(block_size_setting) {
    CHECK_EQ(Pipeline::from_text("").block_size(), std::size_t{256});
    CHECK_EQ(Pipeline::from_text("block_size = 7\n").block_size(), std::size_t{7});
    CHECK_THROWS(Pipeline::from_text("block_size = 0\n"), ConfigError,
                 "line 1: setting 'block_size' must be between 1 and 65536, got '0'");
    CHECK_THROWS(Pipeline::from_text("blocksize = 4\n"), ConfigError, "line 1: unknown setting 'blocksize'");
}

TEST(stage_names) {
    Pipeline p = Pipeline::from_text("[gain]\n[gain]\ndb = 1\n[fade]\n");
    std::vector<std::string> want = {"gain", "gain", "fade"};
    CHECK(p.stage_names() == want);
}

TEST(unknown_stage_and_parameter) {
    CHECK_THROWS(Pipeline::from_text("[gain]\n\n[reverb]\n"), ConfigError, "line 3: unknown stage 'reverb'");
    CHECK_THROWS(Pipeline::from_text("[gain]\ngain = 2\n"), ConfigError,
                 "line 2: stage 'gain': unknown parameter 'gain'");
    CHECK_THROWS(Pipeline::from_text("[fade]\nin_ms = 70000\n"), ConfigError,
                 "line 2: stage 'fade': parameter 'in_ms' must be between 0 and 60000, got '70000'");
}

// Every stateful stage must give the same output whatever the block size.
TEST(block_size_does_not_change_output) {
    const std::string chain = "[fade]\nin_ms = 5\n[lowpass]\ncutoff_hz = 80\n[dcblock]\n[gate]\nhold_ms = 3\nthreshold_db = -12\n";
    std::vector<float> in;
    for (int i = 0; i < 64; ++i) in.push_back(static_cast<float>((i * 37) % 11) / 11.0f - 0.3f);
    auto whole = run_pipeline("block_size = 256\n" + chain, {in, in});
    for (int bs : {1, 3, 7, 64}) {
        auto split = run_pipeline("block_size = " + std::to_string(bs) + "\n" + chain, {in, in});
        CHECK(split == whole);
    }
}

TEST(reset_restarts_the_stream) {
    Pipeline p = Pipeline::from_text("[fade]\nin_ms = 2\n");
    p.prepare(1000, 1);
    AudioBuffer a = AudioBuffer::from_channels({constant(3, 1.0f)});
    p.process(a);
    p.reset();
    AudioBuffer b = AudioBuffer::from_channels({constant(3, 1.0f)});
    p.process(b);
    CHECK(a.samples(0) == b.samples(0));
}

TEST(process_requires_prepare) {
    Pipeline p = Pipeline::from_text("[gain]\n");
    AudioBuffer buf(1, 4);
    CHECK_THROWS(p.process(buf), std::logic_error, "process: pipeline not prepared");
}
