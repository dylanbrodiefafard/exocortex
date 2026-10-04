#include "mkb/registry.hpp"

namespace mkb {

std::vector<std::string> kind_names() {
    std::vector<std::string> names;
    for (const auto& entry : kind_table()) names.push_back(entry.first);
    return names;
}

}  // namespace mkb
