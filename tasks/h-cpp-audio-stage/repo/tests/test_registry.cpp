#include <fstream>
#include <sstream>

#include "pipeline/registry.hpp"
#include "testing.hpp"

using namespace tapeline;

TEST(builtin_registry_is_sorted_and_complete) {
    auto list = builtin_registry().list();
    CHECK(list.size() >= 7);
    for (std::size_t i = 1; i < list.size(); ++i) CHECK(list[i - 1]->name < list[i]->name);
    for (const char* name : {"gain", "clip", "fade", "lowpass", "dcblock", "gate", "pan"}) {
        CHECK(builtin_registry().find(name) != nullptr);
    }
    CHECK(builtin_registry().find("nope") == nullptr);
}

TEST(descriptors_are_well_formed) {
    for (const auto* d : builtin_registry().list()) {
        CHECK(!d->summary.empty());
        CHECK(d->summary.back() != '.');
        CHECK(static_cast<bool>(d->create));
        for (const auto& p : d->params) {
            if (p.type == ParamType::Float || p.type == ParamType::Int) {
                CHECK(p.min <= p.default_number && p.default_number <= p.max);
            }
        }
        // Every stage can be built from its defaults.
        CHECK(d->create(default_params(d->params)) != nullptr);
    }
}

TEST(duplicate_names_rejected) {
    StageRegistry r;
    register_builtin_stages(r);
    StageDescriptor dup = *r.find("gain");
    CHECK_THROWS(r.add(dup), std::logic_error, "stage 'gain' is already registered");
}

// docs/stages.md has a "## <name>" section for every stage, mentioning each
// of its parameters as `name`.
TEST(every_stage_is_documented) {
    std::ifstream in("docs/stages.md");
    CHECK(static_cast<bool>(in));
    std::stringstream ss;
    ss << in.rdbuf();
    const std::string doc = ss.str();
    for (const auto* d : builtin_registry().list()) {
        std::size_t start = doc.find("\n## " + d->name + "\n");
        if (start == std::string::npos) {
            testing::fail(__FILE__, __LINE__, "docs/stages.md has no section for " + d->name);
            continue;
        }
        std::size_t end = doc.find("\n## ", start + 1);
        const std::string section = doc.substr(start, end == std::string::npos ? std::string::npos : end - start);
        for (const auto& p : d->params) {
            if (section.find("`" + p.name + "`") == std::string::npos) {
                testing::fail(__FILE__, __LINE__, "docs/stages.md: " + d->name + " does not document " + p.name);
            }
        }
    }
}
