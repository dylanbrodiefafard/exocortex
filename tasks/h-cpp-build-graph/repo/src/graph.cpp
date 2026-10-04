#include "mkb/graph.hpp"

#include <algorithm>
#include <functional>
#include <queue>
#include <set>

namespace mkb {

std::string Target::name() const {
    return label.substr(label.find(':') + 1);
}

namespace {

bool all_of_chars(const std::string& s, const char* extra) {
    return std::all_of(s.begin(), s.end(), [extra](char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || std::string(extra).find(c) != std::string::npos;
    });
}

}  // namespace

bool valid_label(const std::string& label) {
    if (label.size() < 5 || label.compare(0, 2, "//") != 0) return false;
    auto colon = label.find(':');
    if (colon == std::string::npos || label.find(':', colon + 1) != std::string::npos) return false;
    std::string pkg = label.substr(2, colon - 2);
    std::string name = label.substr(colon + 1);
    if (pkg.empty() || name.empty() || pkg.front() == '/' || pkg.back() == '/') return false;
    return all_of_chars(pkg, "_/") && all_of_chars(name, "_.-");
}

Target& Graph::ref(const std::string& label) {
    auto it = index_.find(label);
    if (it != index_.end()) return targets_[it->second];
    index_.emplace(label, targets_.size());
    Target t;
    t.label = label;
    targets_.push_back(std::move(t));
    return targets_.back();
}

Target& Graph::declare(const std::string& label, const std::string& kind, int line) {
    if (!valid_label(label)) throw GraphError("malformed label '" + label + "'");
    if (find_kind(kind) == nullptr) throw GraphError("unknown rule kind '" + kind + "' for " + label);
    Target& t = ref(label);
    if (t.declared()) throw GraphError(label + " is already declared on line " + std::to_string(t.line));
    t.kind = kind;
    t.line = line;
    return t;
}

const Target* Graph::find(const std::string& label) const {
    auto it = index_.find(label);
    return it == index_.end() ? nullptr : &targets_[it->second];
}

void Graph::check() const {
    std::vector<const Target*> declared;
    for (const auto& t : targets_)
        if (t.declared()) declared.push_back(&t);
    std::sort(declared.begin(), declared.end(), [](const Target* a, const Target* b) { return a->line < b->line; });
    for (const Target* t : declared) {
        const RuleKind* kind = find_kind(t->kind);
        for (const auto& attr : kind->required) {
            if (!t->attrs.count(attr))
                throw GraphError("line " + std::to_string(t->line) + ": " + t->label + " (" + t->kind +
                                 ") is missing required attribute '" + attr + "'");
        }
        for (const auto& dep : t->deps) {
            const Target* d = find(dep);
            if (d == nullptr || !d->declared())
                throw GraphError("line " + std::to_string(t->line) + ": " + t->label +
                                 " depends on undeclared target " + dep);
        }
    }
}

std::vector<std::string> Graph::build_order() const {
    const std::size_t n = targets_.size();
    std::vector<int> pending(n, 0);
    std::vector<std::vector<std::size_t>> users(n);
    for (std::size_t i = 0; i < n; ++i) {
        for (const auto& dep : targets_[i].deps) {
            std::size_t d = index_.at(dep);
            users[d].push_back(i);
            ++pending[i];
        }
    }
    auto later = [this](std::size_t a, std::size_t b) { return targets_[a].line > targets_[b].line; };
    std::priority_queue<std::size_t, std::vector<std::size_t>, decltype(later)> ready(later);
    for (std::size_t i = 0; i < n; ++i)
        if (pending[i] == 0) ready.push(i);

    std::vector<std::string> order;
    while (!ready.empty()) {
        std::size_t i = ready.top();
        ready.pop();
        order.push_back(targets_[i].label);
        for (std::size_t u : users[i])
            if (--pending[u] == 0) ready.push(u);
    }
    if (order.size() == n) return order;

    // Walk dependencies among the unfinished targets until one repeats.
    std::size_t start = n;
    for (std::size_t i = 0; i < n; ++i)
        if (pending[i] > 0 && (start == n || targets_[i].line < targets_[start].line)) start = i;
    std::vector<std::size_t> path;
    std::vector<int> pos(n, -1);
    std::size_t cur = start;
    while (pos[cur] < 0) {
        pos[cur] = static_cast<int>(path.size());
        path.push_back(cur);
        for (const auto& dep : targets_[cur].deps) {
            std::size_t d = index_.at(dep);
            if (pending[d] > 0) {
                cur = d;
                break;
            }
        }
    }
    std::string msg = "dependency cycle: ";
    for (std::size_t k = static_cast<std::size_t>(pos[cur]); k < path.size(); ++k)
        msg += targets_[path[k]].label + " -> ";
    msg += targets_[cur].label;
    throw GraphError(msg);
}

std::vector<std::string> Graph::transitive_outputs(const std::string& label) const {
    const Target* root = find(label);
    if (root == nullptr || !root->declared()) throw GraphError("unknown target " + label);

    std::set<std::string> closure;
    std::function<void(const Target&)> visit = [&](const Target& t) {
        for (const auto& dep : t.deps) {
            if (closure.insert(dep).second) visit(targets_[index_.at(dep)]);
        }
    };
    visit(*root);

    std::vector<std::string> out;
    std::set<std::string> seen;
    auto add = [&](const Target& t) {
        for (auto& file : find_kind(t.kind)->outputs(t))
            if (seen.insert(file).second) out.push_back(file);
    };
    add(*root);
    for (const auto& l : build_order())
        if (l != label && closure.count(l)) add(targets_[index_.at(l)]);
    return out;
}

}  // namespace mkb
