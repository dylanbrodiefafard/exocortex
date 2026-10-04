#include "latency/record.hpp"

#include <sstream>
#include <stdexcept>

#include "latency/csv.hpp"
#include "latency/strutil.hpp"

namespace latency {

namespace {

long parse_long(const std::string& text, const char* what) {
    std::string_view trimmed = strutil::trim(text);
    if (trimmed.empty()) {
        throw std::invalid_argument(std::string("empty ") + what);
    }
    size_t used = 0;
    long value = std::stol(std::string(trimmed), &used);
    if (used != trimmed.size()) {
        throw std::invalid_argument(std::string("bad ") + what + ": " + text);
    }
    return value;
}

}  // namespace

Record parse_record(const std::vector<std::string>& fields) {
    if (fields.size() != 6) {
        throw std::invalid_argument("expected 6 fields, got " + std::to_string(fields.size()));
    }
    Record r;
    r.timestamp = parse_long(fields[0], "timestamp");
    r.method = std::string(strutil::trim(fields[1]));
    r.path = std::string(strutil::trim(fields[2]));
    r.status = parse_long(fields[3], "status");
    r.duration_ms = parse_long(fields[4], "duration");
    r.user_agent = fields[5];
    if (r.status < 100 || r.status > 599) {
        throw std::invalid_argument("status out of range: " + fields[3]);
    }
    if (r.duration_ms < 0) {
        throw std::invalid_argument("negative duration");
    }
    return r;
}

std::vector<Record> read_records(const std::string& csv_text, int* rejected) {
    std::istringstream in(csv_text);
    csv::Reader reader(in);
    std::vector<std::string> fields;
    std::vector<Record> records;
    int bad = 0;
    bool header = true;
    while (reader.next(fields)) {
        if (header) {
            header = false;
            continue;
        }
        try {
            records.push_back(parse_record(fields));
        } catch (const std::exception&) {
            ++bad;
        }
    }
    if (rejected) {
        *rejected = bad;
    }
    return records;
}

}  // namespace latency
