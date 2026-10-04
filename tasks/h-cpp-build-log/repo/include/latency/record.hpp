#pragma once

#include <string>
#include <vector>

namespace latency {

// One request from the access log. Columns, in order:
//   timestamp (unix seconds), method, path, status, duration_ms, user_agent
struct Record {
    long timestamp = 0;
    std::string method;
    std::string path;
    short status = 0;
    long duration_ms = 0;
    std::string user_agent;

    bool is_error() const { return status >= 500; }
    std::string endpoint() const { return method + " " + path; }
};

// Builds a Record from CSV fields; throws std::invalid_argument on malformed input.
Record parse_record(const std::vector<std::string>& fields);

// Reads every record from CSV text with a header row. Rows that fail to parse
// are counted in `rejected` (if non-null) and skipped.
std::vector<Record> read_records(const std::string& csv_text, int* rejected = nullptr);

}  // namespace latency
