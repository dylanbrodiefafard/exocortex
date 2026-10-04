// Manifest files.
//
// One target per line:
//
//   KIND LABEL [ATTR=VALUE[,VALUE...]]...
//
// for example
//
//   cc_binary //app:main srcs=main.cc deps=//lib:util,//lib:log
//
// "deps" lists dependency labels, which may be declared later in the file.
// Blank lines and lines starting with '#' are ignored.
#pragma once

#include <istream>
#include <string>

#include "mkb/graph.hpp"

namespace mkb {

// Parses a manifest into a graph and runs Graph::check(). Errors are
// GraphError with the message prefixed by "line N: " when they belong to a
// line.
Graph parse_manifest(std::istream& in);
Graph parse_manifest(const std::string& text);

}  // namespace mkb
