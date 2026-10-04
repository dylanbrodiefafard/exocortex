// C++ rule kinds.
#include "mkb/graph.hpp"
#include "mkb/registry.hpp"

namespace mkb {
namespace {

std::string package_of(const Target& t) {
    return t.label.substr(2, t.label.find(':') - 2);
}

}  // namespace

MKB_REGISTER_KIND(RuleKind{
    "cc_library",
    {"srcs", "hdrs", "copts"},
    {"srcs"},
    [](const Target& t) { return std::vector<std::string>{package_of(t) + "/lib" + t.name() + ".a"}; },
});

MKB_REGISTER_KIND(RuleKind{
    "cc_binary",
    {"srcs", "copts", "linkopts"},
    {"srcs"},
    [](const Target& t) { return std::vector<std::string>{package_of(t) + "/" + t.name()}; },
});

MKB_REGISTER_KIND(RuleKind{
    "cc_test",
    {"srcs", "copts", "size"},
    {"srcs"},
    [](const Target& t) { return std::vector<std::string>{package_of(t) + "/" + t.name()}; },
});

}  // namespace mkb
