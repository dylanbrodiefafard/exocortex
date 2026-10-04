#include "app/cli.hpp"

#include <fstream>
#include <iomanip>
#include <sstream>

#include "audio/wav.hpp"
#include "config/error.hpp"
#include "pipeline/pipeline.hpp"
#include "pipeline/registry.hpp"

namespace tapeline {

namespace {

const char* const kUsage =
    "usage: tapeline --list-stages\n"
    "       tapeline --describe STAGE\n"
    "       tapeline --check PIPELINE\n"
    "       tapeline -c PIPELINE IN.wav OUT.wav\n";

bool read_file(const std::string& path, std::string& text) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    text = ss.str();
    return true;
}

int list_stages(std::ostream& out) {
    for (const auto* d : builtin_registry().list()) {
        out << std::left << std::setw(10) << d->name << " " << d->summary << "\n";
    }
    return 0;
}

int describe(const std::string& name, std::ostream& out, std::ostream& err) {
    const StageDescriptor* d = builtin_registry().find(name);
    if (d == nullptr) {
        err << "tapeline: unknown stage '" << name << "'\n";
        return 2;
    }
    out << d->name << ": " << d->summary << "\n";
    if (d->params.empty()) out << "  (no parameters)\n";
    for (const auto& p : d->params) {
        out << "  " << std::left << std::setw(14) << p.name << describe_param(p) << "\n";
    }
    return 0;
}

int load(const std::string& path, Pipeline& pipeline, std::ostream& err) {
    std::string text;
    if (!read_file(path, text)) {
        err << "tapeline: cannot read " << path << "\n";
        return 1;
    }
    try {
        pipeline = Pipeline::from_text(text);
    } catch (const ConfigError& e) {
        err << "tapeline: " << path << ": " << e.what() << "\n";
        return 1;
    }
    return 0;
}

int check(const std::string& path, std::ostream& out, std::ostream& err) {
    Pipeline pipeline;
    if (int status = load(path, pipeline, err)) return status;
    out << "ok: " << pipeline.stage_names().size() << " stages, block_size " << pipeline.block_size() << "\n";
    return 0;
}

int process(const std::string& config, const std::string& in_path, const std::string& out_path,
            std::ostream& out, std::ostream& err) {
    Pipeline pipeline;
    if (int status = load(config, pipeline, err)) return status;
    try {
        std::ifstream in(in_path, std::ios::binary);
        if (!in) {
            err << "tapeline: cannot read " << in_path << "\n";
            return 1;
        }
        WavData wav = read_wav(in);
        pipeline.prepare(wav.sample_rate, wav.audio.channels());
        pipeline.process(wav.audio);
        std::ofstream o(out_path, std::ios::binary);
        write_wav(o, wav);
        if (!o) {
            err << "tapeline: cannot write " << out_path << "\n";
            return 1;
        }
        out << "processed " << wav.audio.frames() << " frames through " << pipeline.stage_names().size()
            << " stages\n";
    } catch (const WavError& e) {
        err << "tapeline: " << in_path << ": " << e.what() << "\n";
        return 1;
    } catch (const StageError& e) {
        err << "tapeline: " << e.what() << "\n";
        return 1;
    }
    return 0;
}

}  // namespace

int run_cli(const std::vector<std::string>& args, std::ostream& out, std::ostream& err) {
    if (args.size() == 1 && args[0] == "--list-stages") return list_stages(out);
    if (args.size() == 2 && args[0] == "--describe") return describe(args[1], out, err);
    if (args.size() == 2 && args[0] == "--check") return check(args[1], out, err);
    if (args.size() == 4 && args[0] == "-c") return process(args[1], args[2], args[3], out, err);
    err << kUsage;
    return 2;
}

}  // namespace tapeline
