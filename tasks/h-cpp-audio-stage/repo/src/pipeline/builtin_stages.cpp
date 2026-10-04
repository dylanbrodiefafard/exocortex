#include "pipeline/registry.hpp"
#include "stages/stages.hpp"

namespace tapeline {

void register_builtin_stages(StageRegistry& registry) {
    registry.add(stages::gain_descriptor());
    registry.add(stages::clip_descriptor());
    registry.add(stages::fade_descriptor());
    registry.add(stages::lowpass_descriptor());
    registry.add(stages::dcblock_descriptor());
    registry.add(stages::gate_descriptor());
    registry.add(stages::pan_descriptor());
}

}  // namespace tapeline
