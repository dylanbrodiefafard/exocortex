#pragma once

#include "pipeline/stage.hpp"

// The built-in stages. Each is defined in its own file and registered in
// pipeline/builtin_stages.cpp; each is documented in docs/stages.md.
namespace tapeline::stages {

StageDescriptor gain_descriptor();
StageDescriptor clip_descriptor();
StageDescriptor fade_descriptor();
StageDescriptor lowpass_descriptor();
StageDescriptor dcblock_descriptor();
StageDescriptor gate_descriptor();
StageDescriptor pan_descriptor();

}  // namespace tapeline::stages
