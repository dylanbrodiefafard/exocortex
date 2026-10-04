#include "config/parser.hpp"

#include <cctype>
#include <sstream>

#include "config/error.hpp"

namespace tapeline {

namespace {

std::string trim(const std::string& s) {
    std::size_t b = 0, e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return s.substr(b, e - b);
}

std::string strip_comment(const std::string& line) {
    std::size_t hash = line.find('#');
    return hash == std::string::npos ? line : line.substr(0, hash);
}

bool valid_name(const std::string& name) {
    if (name.empty()) return false;
    for (char c : name) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) return false;
    }
    return true;
}

}  // namespace

PipelineText parse_pipeline_text(const std::string& text) {
    PipelineText result;
    std::istringstream in(text);
    std::string raw;
    int number = 0;
    while (std::getline(in, raw)) {
        ++number;
        std::string line = trim(strip_comment(raw));
        if (line.empty()) continue;
        if (line.front() == '[') {
            if (line.back() != ']') throw ConfigError(number, "expected ']' at the end of the stage header");
            std::string name = trim(line.substr(1, line.size() - 2));
            if (!valid_name(name)) throw ConfigError(number, "invalid stage name '" + name + "'");
            result.stages.push_back(StageSection{name, number, {}});
            continue;
        }
        std::size_t eq = line.find('=');
        if (eq == std::string::npos) throw ConfigError(number, "expected 'key = value' or '[stage]'");
        std::string key = trim(line.substr(0, eq));
        std::string value = trim(line.substr(eq + 1));
        if (!valid_name(key)) throw ConfigError(number, "invalid key '" + key + "'");
        if (value.empty()) throw ConfigError(number, "missing value for '" + key + "'");
        RawParam param{key, value, number};
        if (result.stages.empty()) {
            result.settings.push_back(param);
        } else {
            result.stages.back().params.push_back(param);
        }
    }
    return result;
}

}  // namespace tapeline
