// Rule kinds.
//
// A rule kind ("cc_library", "genrule", ...) says which attributes a target
// of that kind accepts and which files it produces. Kinds register
// themselves during static initialization, from any translation unit, with
// MKB_REGISTER_KIND; every registered kind is visible to the whole program
// through find_kind() and kind_names().
#pragma once

#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace mkb {

struct Target;

struct RuleKind {
    std::string name;
    // Attribute names a target of this kind may set (besides "deps").
    std::set<std::string> attrs;
    // Attribute names a target of this kind must set.
    std::set<std::string> required;
    // Files the target produces.
    std::function<std::vector<std::string>(const Target&)> outputs;
};

using KindTable = std::map<std::string, RuleKind>;

KindTable& kind_table() {
    static KindTable table;
    return table;
}

// The registered kind called `name`, or nullptr.
const RuleKind* find_kind(const std::string& name) {
    auto it = kind_table().find(name);
    return it == kind_table().end() ? nullptr : &it->second;
}

// Names of all registered kinds, sorted.
std::vector<std::string> kind_names();

struct KindRegistrar {
    explicit KindRegistrar(RuleKind kind) {
        std::string name = kind.name;
        kind_table().emplace(std::move(name), std::move(kind));
    }
};

#define MKB_CONCAT_(a, b) a##b
#define MKB_CONCAT(a, b) MKB_CONCAT_(a, b)
#define MKB_REGISTER_KIND(...) \
    static const ::mkb::KindRegistrar MKB_CONCAT(mkb_kind_registrar_, __LINE__){__VA_ARGS__}

}  // namespace mkb
