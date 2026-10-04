#include "pipeline/registry.hpp"

#include <algorithm>
#include <stdexcept>

namespace tapeline {

void StageRegistry::add(StageDescriptor descriptor) {
    if (find(descriptor.name) != nullptr) {
        throw std::logic_error("stage '" + descriptor.name + "' is already registered");
    }
    descriptors_.push_back(std::move(descriptor));
}

const StageDescriptor* StageRegistry::find(const std::string& name) const {
    for (const auto& d : descriptors_) {
        if (d.name == name) return &d;
    }
    return nullptr;
}

std::vector<const StageDescriptor*> StageRegistry::list() const {
    std::vector<const StageDescriptor*> out;
    for (const auto& d : descriptors_) out.push_back(&d);
    std::sort(out.begin(), out.end(), [](const auto* a, const auto* b) { return a->name < b->name; });
    return out;
}

const StageRegistry& builtin_registry() {
    static const StageRegistry registry = [] {
        StageRegistry r;
        register_builtin_stages(r);
        return r;
    }();
    return registry;
}

}  // namespace tapeline
