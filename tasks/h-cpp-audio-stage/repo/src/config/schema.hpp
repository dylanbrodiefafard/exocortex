#pragma once

#include <map>
#include <string>
#include <vector>

#include "config/parser.hpp"

namespace tapeline {

enum class ParamType { Float, Int, Bool, Choice };

// The declaration of one parameter: its type, default and allowed values.
// Stages declare their parameters with these; resolve_params() does all the
// checking, so stages never parse or validate values themselves.
struct ParamSpec {
    std::string name;
    ParamType type = ParamType::Float;
    double default_number = 0.0;
    bool default_flag = false;
    std::string default_choice;
    double min = 0.0;
    double max = 0.0;
    std::vector<std::string> choices;

    static ParamSpec number(std::string name, double default_value, double min, double max);
    static ParamSpec integer(std::string name, int default_value, int min, int max);
    static ParamSpec flag(std::string name, bool default_value);
    static ParamSpec choice(std::string name, std::string default_value, std::vector<std::string> choices);
};

// Validated parameter values, defaults filled in.
class Params {
public:
    double number(const std::string& name) const;
    int integer(const std::string& name) const;
    bool flag(const std::string& name) const;
    const std::string& choice(const std::string& name) const;

    void set_number(const std::string& name, double v) { numbers_[name] = v; }
    void set_flag(const std::string& name, bool v) { flags_[name] = v; }
    void set_choice(const std::string& name, std::string v) { choices_[name] = std::move(v); }

private:
    std::map<std::string, double> numbers_;
    std::map<std::string, bool> flags_;
    std::map<std::string, std::string> choices_;
};

// Checks `raw` against `specs` and fills in defaults. `owner` names what the
// parameters belong to in messages: "stage 'gain'" gives
// "line 4: stage 'gain': parameter 'db' must be between -60 and 24, got 30";
// an empty owner is used for the file's settings and gives
// "line 2: setting 'block_size' must be ...". Throws ConfigError.
Params resolve_params(const std::string& owner, const std::vector<ParamSpec>& specs,
                      const std::vector<RawParam>& raw);

// Params with every default (no file involved).
Params default_params(const std::vector<ParamSpec>& specs);

std::string type_name(ParamType type);

// One line describing a parameter for `tapeline --describe`, without the
// name: "float  default 0, range -60 to 24".
std::string describe_param(const ParamSpec& spec);

}  // namespace tapeline
