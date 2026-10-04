#include "latency/strutil.hpp"

#include <cctype>
#include <cstdio>

namespace latency::strutil {

std::string_view trim(std::string_view s) {
    size_t begin = 0;
    size_t end = s.size();
    while (begin < end && std::isspace((unsigned char)s[begin])) {
        ++begin;
    }
    while (end > begin && std::isspace((unsigned char)s[end - 1])) {
        --end;
    }
    return s.substr(begin, end - begin);
}

std::vector<std::string> split(std::string_view s, char sep) {
    std::vector<std::string> parts;
    int start = 0;
    for (int i = 0; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == sep) {
            parts.emplace_back(s.substr(start, i - start));
            start = i + 1;
        }
    }
    return parts;
}

bool starts_with(std::string_view s, std::string_view prefix) {
    return s.substr(0, prefix.size()) == prefix;
}

std::string to_lower(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        out.push_back(std::tolower(c));
    }
    return out;
}

std::string format_ms(double ms, int precision) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "%.*f ms", precision, ms);
    return buf;
}

}  // namespace latency::strutil
