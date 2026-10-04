#pragma once

#include <ostream>
#include <string>
#include <vector>

namespace tapeline {

// Runs the command line `args` (without the program name). Returns the exit
// status: 0 on success, 1 when the pipeline or audio is invalid, 2 for a
// wrong command line. Errors are written to `err` as "tapeline: <message>".
int run_cli(const std::vector<std::string>& args, std::ostream& out, std::ostream& err);

}  // namespace tapeline
