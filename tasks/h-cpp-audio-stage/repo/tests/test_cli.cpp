#include <cstdio>
#include <fstream>
#include <sstream>

#include "app/cli.hpp"
#include "audio/wav.hpp"
#include "pipeline/registry.hpp"
#include "testing.hpp"

using namespace tapeline;

namespace {

struct Result {
    int code;
    std::string out;
    std::string err;
};

Result cli(const std::vector<std::string>& args) {
    std::ostringstream out, err;
    int code = run_cli(args, out, err);
    return {code, out.str(), err.str()};
}

std::string temp_file(const std::string& name, const std::string& content) {
    std::string path = "build/" + name;
    std::ofstream(path, std::ios::binary) << content;
    return path;
}

}  // namespace

TEST(list_stages_shows_every_stage_sorted) {
    Result r = cli({"--list-stages"});
    CHECK_EQ(r.code, 0);
    std::string want;
    for (const auto* d : builtin_registry().list()) {
        std::string name = d->name;
        name.resize(10, ' ');
        want += name + " " + d->summary + "\n";
    }
    CHECK_EQ(r.out, want);
    CHECK(r.out.find("gate       Silence quiet passages after a hold time\n") != std::string::npos);
}

TEST(describe_lists_parameters) {
    Result r = cli({"--describe", "gate"});
    CHECK_EQ(r.code, 0);
    CHECK_EQ(r.out, std::string("gate: Silence quiet passages after a hold time\n"
                                "  threshold_db  float  default -50, range -100 to 0\n"
                                "  hold_ms       float  default 50, range 0 to 5000\n"));
    Result bad = cli({"--describe", "reverb"});
    CHECK_EQ(bad.code, 2);
    CHECK_EQ(bad.err, std::string("tapeline: unknown stage 'reverb'\n"));
}

TEST(check_reports_config_errors_with_file_and_line) {
    std::string good = temp_file("good.conf", "block_size = 128\n[gain]\ndb = -3\n[clip]\n");
    Result ok = cli({"--check", good});
    CHECK_EQ(ok.code, 0);
    CHECK_EQ(ok.out, std::string("ok: 2 stages, block_size 128\n"));
    std::string bad = temp_file("bad.conf", "[gain]\ndb = 99\n");
    Result r = cli({"--check", bad});
    CHECK_EQ(r.code, 1);
    CHECK_EQ(r.err, "tapeline: " + bad + ": line 2: stage 'gain': parameter 'db' must be between -60 and 24, got '99'\n");
}

TEST(process_wav_file) {
    WavData wav;
    wav.sample_rate = 8000;
    wav.audio = AudioBuffer::from_channels({{0.5f, -0.5f, 0.25f}});
    std::ostringstream bytes;
    write_wav(bytes, wav);
    std::string in = temp_file("in.wav", bytes.str());
    std::string conf = temp_file("half.conf", "[gain]\ndb = -6.0206\n");
    Result r = cli({"-c", conf, in, "build/out.wav"});
    CHECK_EQ(r.code, 0);
    CHECK_EQ(r.out, std::string("processed 3 frames through 1 stages\n"));
    std::ifstream result("build/out.wav", std::ios::binary);
    WavData back = read_wav(result);
    CHECK_NEAR(back.audio.at(0, 0), 0.25, 1e-3);
    CHECK_NEAR(back.audio.at(0, 2), 0.125, 1e-3);
}

TEST(stage_errors_while_processing) {
    WavData wav;
    wav.sample_rate = 8000;
    wav.audio = AudioBuffer::from_channels({{0.5f}});
    std::ostringstream bytes;
    write_wav(bytes, wav);
    std::string in = temp_file("mono.wav", bytes.str());
    std::string conf = temp_file("pan.conf", "[pan]\n");
    Result r = cli({"-c", conf, in, "build/never.wav"});
    CHECK_EQ(r.code, 1);
    CHECK_EQ(r.err, std::string("tapeline: stage 'pan': needs 2 channels, got 1\n"));
}

TEST(usage) {
    Result r = cli({"--frobnicate"});
    CHECK_EQ(r.code, 2);
    CHECK(r.err.rfind("usage: tapeline --list-stages\n", 0) == 0);
}
