// The target graph.
#pragma once

#include <map>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "mkb/registry.hpp"

namespace mkb {

struct Target {
    std::string label;  // "//pkg:name"
    std::string kind;   // empty until the target is declared
    std::map<std::string, std::vector<std::string>> attrs;
    std::vector<std::string> deps;  // labels, in declaration order
    int line = 0;                   // manifest line that declared it, 0 if undeclared

    bool declared() const { return !kind.empty(); }
    // The part of the label after ':'.
    std::string name() const;
};

struct GraphError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

class Graph {
public:
    // Declares a target. Throws GraphError if the label is malformed, the
    // kind is unknown, or the label was already declared. A label that was
    // only referenced so far (as a dependency) becomes declared.
    Target& declare(const std::string& label, const std::string& kind, int line);

    // The target with this label, creating an undeclared placeholder if it
    // has not been seen yet. Used for dependencies that may be declared
    // later in the manifest.
    Target& ref(const std::string& label);

    // nullptr if the label has never been seen.
    const Target* find(const std::string& label) const;

    std::size_t size() const { return targets_.size(); }

    // Checks that every referenced target is declared and has the attributes
    // its kind requires; throws GraphError naming the first problem.
    void check() const;

    // Labels in an order where every target comes after all of its
    // dependencies; among targets whose dependencies are satisfied, the one
    // declared first comes first. Throws GraphError on a cycle, naming the
    // labels on it ("dependency cycle: //a:a -> //b:b -> //a:a").
    std::vector<std::string> build_order() const;

    // The outputs of `label` followed by those of everything it depends on,
    // transitively, in build order, without duplicates.
    std::vector<std::string> transitive_outputs(const std::string& label) const;

private:
    std::vector<Target> targets_;
    std::unordered_map<std::string, std::size_t> index_;
};

// Whether `label` is "//pkg:name" with pkg made of [a-z0-9_/] (not starting
// or ending with '/') and name of [a-z0-9_.-], both non-empty.
bool valid_label(const std::string& label);

}  // namespace mkb
