#pragma once

#include <map>
#include <string>
#include <vector>

#include "latency/record.hpp"

namespace latency {

struct EndpointStats {
    std::string endpoint;
    int requests = 0;
    int errors = 0;
    double mean_ms = 0.0;
    long p50_ms = 0;
    long p95_ms = 0;
    long max_ms = 0;
};

// Per-endpoint statistics, sorted by request count (descending), then endpoint name.
std::vector<EndpointStats> summarize(const std::vector<Record>& records);

// Requests per user agent.
std::map<std::string, int> requests_by_agent(const std::vector<Record>& records);

// Fixed-width text table of `summarize` output.
std::string render_table(const std::vector<EndpointStats>& rows);

}  // namespace latency
