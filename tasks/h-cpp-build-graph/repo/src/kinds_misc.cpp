// Language-independent rule kinds.
#include "mkb/graph.hpp"
#include "mkb/registry.hpp"

namespace mkb {
namespace {

std::vector<std::string> in_package(const Target& t, const std::string& attr) {
    std::vector<std::string> out;
    auto it = t.attrs.find(attr);
    if (it == t.attrs.end()) return out;
    std::string pkg = t.label.substr(2, t.label.find(':') - 2);
    for (const auto& file : it->second) out.push_back(pkg + "/" + file);
    return out;
}

}  // namespace

MKB_REGISTER_KIND(RuleKind{
    "genrule",
    {"srcs", "outs", "tool"},
    {"outs", "tool"},
    [](const Target& t) { return in_package(t, "outs"); },
});

MKB_REGISTER_KIND(RuleKind{
    "filegroup",
    {"srcs"},
    {"srcs"},
    [](const Target& t) { return in_package(t, "srcs"); },
});

}  // namespace mkb
