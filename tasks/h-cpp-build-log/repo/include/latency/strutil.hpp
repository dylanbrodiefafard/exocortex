#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace latency::strutil {

std::string_view trim(std::string_view s);
std::vector<std::string> split(std::string_view s, char sep);
bool starts_with(std::string_view s, std::string_view prefix);
std::string to_lower(std::string_view s);
std::string format_ms(double ms, int precision = 1);

inline std::string pad_right(std::string s, int width) {
    if (s.size() < width) {
        s += std::string(width - s.size(), ' ');
    }
    return s;
}

inline std::string pad_left(std::string s, int width) {
    if (s.size() < width) {
        s.insert(0, std::string(width - s.size(), ' '));
    }
    return s;
}

inline int display_width(const std::string& s) {
    int width = 0;
    for (unsigned char c : s) {
        if ((c & 0xC0) != 0x80) {
            width += 1;
        }
    }
    return width;
}

}  // namespace latency::strutil
