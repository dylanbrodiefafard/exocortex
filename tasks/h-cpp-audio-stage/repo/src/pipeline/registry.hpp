#pragma once

#include <string>
#include <vector>

#include "pipeline/stage.hpp"

namespace tapeline {

class StageRegistry {
public:
    // Adds a kind of stage. Throws std::logic_error if the name is taken.
    void add(StageDescriptor descriptor);

    // The descriptor called `name`, or nullptr.
    const StageDescriptor* find(const std::string& name) const;

    // Every descriptor, sorted by name.
    std::vector<const StageDescriptor*> list() const;

private:
    std::vector<StageDescriptor> descriptors_;
};

// Adds every built-in stage to `registry`.
void register_builtin_stages(StageRegistry& registry);

// A registry holding the built-in stages.
const StageRegistry& builtin_registry();

}  // namespace tapeline
