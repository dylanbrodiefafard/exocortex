#include "mkb/manifest.hpp"

#include <sstream>

namespace mkb {

namespace {

std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> parts;
    std::string cur;
    std::istringstream in(s);
    while (std::getline(in, cur, sep)) parts.push_back(cur);
    if (!s.empty() && s.back() == sep) parts.emplace_back();
    return parts;
}

[[noreturn]] void fail(int line, const std::string& msg) {
    throw GraphError("line " + std::to_string(line) + ": " + msg);
}

void parse_line(Graph& g, const std::string& text, int lineno) {
    std::istringstream words(text);
    std::string kind, label, word;
    words >> kind >> label;
    if (label.empty()) fail(lineno, "expected KIND LABEL");

    Target* declared = nullptr;
    try {
        declared = &g.declare(label, kind, lineno);
    } catch (const GraphError& e) {
        fail(lineno, e.what());
    }
    Target& t = *declared;
    const RuleKind* rule = find_kind(kind);

    while (words >> word) {
        auto eq = word.find('=');
        if (eq == std::string::npos || eq == 0) fail(lineno, "expected ATTR=VALUE, got '" + word + "'");
        std::string key = word.substr(0, eq);
        std::vector<std::string> values = split(word.substr(eq + 1), ',');
        for (const auto& v : values)
            if (v.empty()) fail(lineno, "empty value in '" + word + "'");
        if (key != "deps" && !rule->attrs.count(key)) fail(lineno, kind + " does not accept attribute '" + key + "'");
        if (t.attrs.count(key) || (key == "deps" && !t.deps.empty()))
            fail(lineno, "attribute '" + key + "' given twice");
        if (key == "deps") {
            for (const auto& dep : values) {
                if (!valid_label(dep)) fail(lineno, "malformed label '" + dep + "'");
                if (dep == label) fail(lineno, label + " depends on itself");
                g.ref(dep);
                t.deps.push_back(dep);
            }
        } else {
            t.attrs[key] = values;
        }
    }
}

}  // namespace

Graph parse_manifest(std::istream& in) {
    Graph g;
    std::string line;
    int lineno = 0;
    while (std::getline(in, line)) {
        ++lineno;
        auto first = line.find_first_not_of(" \t\r");
        if (first == std::string::npos || line[first] == '#') continue;
        parse_line(g, line, lineno);
    }
    g.check();
    return g;
}

Graph parse_manifest(const std::string& text) {
    std::istringstream in(text);
    return parse_manifest(in);
}

}  // namespace mkb
