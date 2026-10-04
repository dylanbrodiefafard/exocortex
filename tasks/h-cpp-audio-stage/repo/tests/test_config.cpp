#include "config/error.hpp"
#include "config/parser.hpp"
#include "config/schema.hpp"
#include "testing.hpp"

using namespace tapeline;

TEST(parser_splits_settings_and_stages) {
    PipelineText t = parse_pipeline_text(
        "# a comment\n"
        "block_size = 64\n"
        "\n"
        "[gain]\n"
        "db = -6   # trailing comment\n"
        "[ clip ]\n"
        "[gain]\n");
    CHECK_EQ(t.settings.size(), std::size_t{1});
    CHECK_EQ(t.settings[0].key, std::string("block_size"));
    CHECK_EQ(t.settings[0].line, 2);
    CHECK_EQ(t.stages.size(), std::size_t{3});
    CHECK_EQ(t.stages[0].name, std::string("gain"));
    CHECK_EQ(t.stages[0].line, 4);
    CHECK_EQ(t.stages[0].params[0].value, std::string("-6"));
    CHECK_EQ(t.stages[0].params[0].line, 5);
    CHECK_EQ(t.stages[1].name, std::string("clip"));
    CHECK(t.stages[2].params.empty());
}

TEST(parser_errors) {
    CHECK_THROWS(parse_pipeline_text("[gain\n"), ConfigError, "line 1: expected ']' at the end of the stage header");
    CHECK_THROWS(parse_pipeline_text("\n[]\n"), ConfigError, "line 2: invalid stage name ''");
    CHECK_THROWS(parse_pipeline_text("[gain]\njust words\n"), ConfigError,
                 "line 2: expected 'key = value' or '[stage]'");
    CHECK_THROWS(parse_pipeline_text("[gain]\ndb =\n"), ConfigError, "line 2: missing value for 'db'");
    CHECK_THROWS(parse_pipeline_text("a b = 1\n"), ConfigError, "line 1: invalid key 'a b'");
}

static const std::vector<ParamSpec> kSpecs = {
    ParamSpec::number("db", 0.0, -60.0, 24.0),
    ParamSpec::integer("count", 4, 1, 16),
    ParamSpec::flag("invert", false),
    ParamSpec::choice("mode", "hard", {"hard", "soft"}),
};

static std::vector<RawParam> one(const std::string& key, const std::string& value) {
    return {RawParam{key, value, 7}};
}

TEST(resolve_fills_defaults) {
    Params p = resolve_params("stage 'x'", kSpecs, {});
    CHECK_EQ(p.number("db"), 0.0);
    CHECK_EQ(p.integer("count"), 4);
    CHECK_EQ(p.flag("invert"), false);
    CHECK_EQ(p.choice("mode"), std::string("hard"));
}

TEST(resolve_parses_values) {
    CHECK_EQ(resolve_params("stage 'x'", kSpecs, one("db", "-6.5")).number("db"), -6.5);
    CHECK_EQ(resolve_params("stage 'x'", kSpecs, one("count", "16")).integer("count"), 16);
    CHECK_EQ(resolve_params("stage 'x'", kSpecs, one("invert", "true")).flag("invert"), true);
    CHECK_EQ(resolve_params("stage 'x'", kSpecs, one("mode", "soft")).choice("mode"), std::string("soft"));
}

TEST(resolve_reports_problems) {
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, one("dB", "1")), ConfigError,
                 "line 7: stage 'x': unknown parameter 'dB'");
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, one("db", "loud")), ConfigError,
                 "line 7: stage 'x': parameter 'db' must be a number, got 'loud'");
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, one("db", "30")), ConfigError,
                 "line 7: stage 'x': parameter 'db' must be between -60 and 24, got '30'");
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, one("count", "2.5")), ConfigError,
                 "line 7: stage 'x': parameter 'count' must be an integer, got '2.5'");
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, one("invert", "yes")), ConfigError,
                 "line 7: stage 'x': parameter 'invert' must be true or false, got 'yes'");
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, one("mode", "medium")), ConfigError,
                 "line 7: stage 'x': parameter 'mode' must be one of hard, soft, got 'medium'");
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, one("db", "nan")), ConfigError,
                 "line 7: stage 'x': parameter 'db' must be a number, got 'nan'");
    std::vector<RawParam> twice = {RawParam{"db", "1", 3}, RawParam{"db", "2", 4}};
    CHECK_THROWS(resolve_params("stage 'x'", kSpecs, twice), ConfigError,
                 "line 4: stage 'x': parameter 'db' given twice");
}

TEST(resolve_settings_wording) {
    CHECK_THROWS(resolve_params("", kSpecs, one("speed", "1")), ConfigError, "line 7: unknown setting 'speed'");
    CHECK_THROWS(resolve_params("", kSpecs, one("count", "0")), ConfigError,
                 "line 7: setting 'count' must be between 1 and 16, got '0'");
}

TEST(describe_param_lines) {
    CHECK_EQ(describe_param(kSpecs[0]), std::string("float  default 0, range -60 to 24"));
    CHECK_EQ(describe_param(kSpecs[1]), std::string("int    default 4, range 1 to 16"));
    CHECK_EQ(describe_param(kSpecs[2]), std::string("bool   default false"));
    CHECK_EQ(describe_param(kSpecs[3]), std::string("choice default hard, one of hard, soft"));
}
