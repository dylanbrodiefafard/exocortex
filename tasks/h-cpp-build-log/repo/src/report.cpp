#include "latency/report.hpp"

#include <algorithm>
#include <cstdio>

#include "latency/stats.hpp"
#include "latency/strutil.hpp"

namespace latency {

std::vector<EndpointStats> summarize(const std::vector<Record>& records) {
    std::map<std::string, std::vector<const Record*>> groups;
    for (const Record& r : records) {
        groups[r.endpoint()].push_back(&r);
    }
    std::vector<EndpointStats> rows;
    for (const auto& [endpoint, group] : groups) {
        EndpointStats s;
        s.endpoint = endpoint;
        s.requests = group.size();
        std::vector<long> durations;
        durations.reserve(group.size());
        for (const Record* r : group) {
            durations.push_back(r->duration_ms);
            if (r->is_error()) {
                s.errors += 1;
            }
        }
        s.mean_ms = stats::mean(durations);
        s.p50_ms = stats::percentile(durations, 50);
        s.p95_ms = stats::percentile(durations, 95);
        s.max_ms = stats::max_value(durations);
        rows.push_back(s);
    }
    std::sort(rows.begin(), rows.end(), [](const EndpointStats& a, const EndpointStats& b) {
        if (a.requests != b.requests) {
            return a.requests > b.requests;
        }
        return a.endpoint < b.endpoint;
    });
    return rows;
}

std::map<std::string, int> requests_by_agent(const std::vector<Record>& records) {
    std::map<std::string, int> counts;
    for (const Record& r : records) {
        counts[r.user_agent] += 1;
    }
    return counts;
}

std::string render_table(const std::vector<EndpointStats>& rows) {
    int width = 8;
    for (const EndpointStats& row : rows) {
        width = std::max(width, strutil::display_width(row.endpoint));
    }
    std::string out = strutil::pad_right("endpoint", width) + "  reqs  errs     mean    p50    p95    max\n";
    for (const EndpointStats& row : rows) {
        int col = 6;
        char nums[96];
        std::snprintf(nums, sizeof nums, "%*d%*d %8.1f%7ld%7ld%7ld", col, row.requests, col, row.errors,
                      row.mean_ms, row.p50_ms, row.p95_ms, row.max_ms);
        out += strutil::pad_right(row.endpoint, width);
        out += nums;
        out += "\n";
    }
    return out;
}

}  // namespace latency
