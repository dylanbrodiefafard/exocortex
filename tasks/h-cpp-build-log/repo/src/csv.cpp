#include "latency/csv.hpp"

namespace latency::csv {

std::vector<std::string> split_line(std::string_view line) {
    std::vector<std::string> fields;
    std::string current;
    bool in_quotes = false;
    for (char c : line) {
        if (c == '"') {
            in_quotes = !in_quotes;
            continue;
        }
        if (c == ',' && !in_quotes) {
            fields.push_back(std::move(current));
            current.clear();
            continue;
        }
        current.push_back(c);
    }
    if (in_quotes) {
        throw ParseError("unterminated quoted field");
    }
    fields.push_back(std::move(current));
    return fields;
}

bool Reader::next(std::vector<std::string>& fields) {
    std::string line;
    while (std::getline(in_, line)) {
        ++line_number_;
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (line.empty() || line[0] == '#') {
            continue;
        }
        fields = split_line(line);
        return true;
    }
    return false;
}

}  // namespace latency::csv
