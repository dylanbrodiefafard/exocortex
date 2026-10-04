#include "config/schema.hpp"

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <set>
#include <stdexcept>

#include "config/error.hpp"
#include "dsp/util.hpp"

namespace tapeline {

using dsp::format_number;

ParamSpec ParamSpec::number(std::string name, double default_value, double min, double max) {
    ParamSpec s;
    s.name = std::move(name);
    s.type = ParamType::Float;
    s.default_number = default_value;
    s.min = min;
    s.max = max;
    return s;
}

ParamSpec ParamSpec::integer(std::string name, int default_value, int min, int max) {
    ParamSpec s = number(std::move(name), default_value, min, max);
    s.type = ParamType::Int;
    return s;
}

ParamSpec ParamSpec::flag(std::string name, bool default_value) {
    ParamSpec s;
    s.name = std::move(name);
    s.type = ParamType::Bool;
    s.default_flag = default_value;
    return s;
}

ParamSpec ParamSpec::choice(std::string name, std::string default_value, std::vector<std::string> choices) {
    ParamSpec s;
    s.name = std::move(name);
    s.type = ParamType::Choice;
    s.default_choice = std::move(default_value);
    s.choices = std::move(choices);
    return s;
}

namespace {

template <typename Map>
const typename Map::mapped_type& lookup(const Map& map, const std::string& name, const char* kind) {
    auto it = map.find(name);
    if (it == map.end()) throw std::logic_error(std::string("no ") + kind + " parameter '" + name + "'");
    return it->second;
}

bool parse_double(const std::string& text, double& out) {
    errno = 0;
    char* end = nullptr;
    out = std::strtod(text.c_str(), &end);
    return end != text.c_str() && *end == '\0' && errno == 0 && std::isfinite(out);
}

std::string join(const std::vector<std::string>& items) {
    std::string out;
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i > 0) out += ", ";
        out += items[i];
    }
    return out;
}

}  // namespace

double Params::number(const std::string& name) const { return lookup(numbers_, name, "numeric"); }

int Params::integer(const std::string& name) const {
    return static_cast<int>(lookup(numbers_, name, "numeric"));
}

bool Params::flag(const std::string& name) const { return lookup(flags_, name, "boolean"); }

const std::string& Params::choice(const std::string& name) const { return lookup(choices_, name, "choice"); }

Params default_params(const std::vector<ParamSpec>& specs) {
    Params p;
    for (const auto& s : specs) {
        switch (s.type) {
            case ParamType::Float:
            case ParamType::Int: p.set_number(s.name, s.default_number); break;
            case ParamType::Bool: p.set_flag(s.name, s.default_flag); break;
            case ParamType::Choice: p.set_choice(s.name, s.default_choice); break;
        }
    }
    return p;
}

Params resolve_params(const std::string& owner, const std::vector<ParamSpec>& specs,
                      const std::vector<RawParam>& raw) {
    Params params = default_params(specs);
    std::set<std::string> seen;
    for (const auto& r : raw) {
        const std::string subject = owner.empty() ? "setting '" + r.key + "'" : owner + ": parameter '" + r.key + "'";
        const ParamSpec* spec = nullptr;
        for (const auto& s : specs) {
            if (s.name == r.key) spec = &s;
        }
        if (spec == nullptr) {
            throw ConfigError(r.line, owner.empty() ? "unknown setting '" + r.key + "'"
                                                    : owner + ": unknown parameter '" + r.key + "'");
        }
        if (!seen.insert(r.key).second) throw ConfigError(r.line, subject + " given twice");
        auto fail = [&](const std::string& what) {
            throw ConfigError(r.line, subject + " must be " + what + ", got '" + r.value + "'");
        };
        switch (spec->type) {
            case ParamType::Float:
            case ParamType::Int: {
                double v = 0.0;
                if (!parse_double(r.value, v)) fail(spec->type == ParamType::Int ? "an integer" : "a number");
                if (spec->type == ParamType::Int && v != std::floor(v)) fail("an integer");
                if (v < spec->min || v > spec->max) {
                    fail("between " + format_number(spec->min) + " and " + format_number(spec->max));
                }
                params.set_number(spec->name, v);
                break;
            }
            case ParamType::Bool:
                if (r.value == "true") {
                    params.set_flag(spec->name, true);
                } else if (r.value == "false") {
                    params.set_flag(spec->name, false);
                } else {
                    fail("true or false");
                }
                break;
            case ParamType::Choice: {
                bool ok = false;
                for (const auto& c : spec->choices) ok = ok || c == r.value;
                if (!ok) fail("one of " + join(spec->choices));
                params.set_choice(spec->name, r.value);
                break;
            }
        }
    }
    return params;
}

std::string type_name(ParamType type) {
    switch (type) {
        case ParamType::Float: return "float";
        case ParamType::Int: return "int";
        case ParamType::Bool: return "bool";
        case ParamType::Choice: return "choice";
    }
    return "?";
}

std::string describe_param(const ParamSpec& spec) {
    std::string out = type_name(spec.type);
    while (out.size() < 7) out += ' ';
    switch (spec.type) {
        case ParamType::Float:
        case ParamType::Int:
            return out + "default " + format_number(spec.default_number) + ", range " + format_number(spec.min) +
                   " to " + format_number(spec.max);
        case ParamType::Bool: return out + "default " + (spec.default_flag ? "true" : "false");
        case ParamType::Choice: return out + "default " + spec.default_choice + ", one of " + join(spec.choices);
    }
    return out;
}

}  // namespace tapeline
