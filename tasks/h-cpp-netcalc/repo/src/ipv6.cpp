#include "netcalc/ipv6.hpp"

#include <cstdio>
#include <vector>

namespace netcalc {

namespace {

[[noreturn]] void fail(std::string_view text, const char* why) {
    throw ParseError("invalid IPv6 address '" + std::string(text) + "': " + why);
}

int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Parses a ':'-separated list of groups (no "::"), appending to out. The last element
// may be a dotted quad, which contributes two groups.
void parse_groups(std::string_view whole, std::string_view part, bool allow_v4, std::vector<std::uint16_t>& out) {
    if (part.empty()) {
        return;
    }
    std::size_t start = 0;
    while (true) {
        std::size_t colon = part.find(':', start);
        std::string_view g = part.substr(start, colon == std::string_view::npos ? std::string_view::npos : colon - start);
        bool last = colon == std::string_view::npos;
        if (last && allow_v4 && g.find('.') != std::string_view::npos) {
            auto v4 = Ipv4::try_parse(g);
            if (!v4) fail(whole, "bad embedded IPv4 address");
            out.push_back(static_cast<std::uint16_t>(v4->value >> 16));
            out.push_back(static_cast<std::uint16_t>(v4->value & 0xffff));
            return;
        }
        if (g.empty() || g.size() > 4) fail(whole, "bad group");
        unsigned v = 0;
        for (char c : g) {
            int h = hex_value(c);
            if (h < 0) fail(whole, "bad hex digit");
            v = v * 16 + static_cast<unsigned>(h);
        }
        out.push_back(static_cast<std::uint16_t>(v));
        if (last) {
            return;
        }
        start = colon + 1;
    }
}

}  // namespace

Ipv6 Ipv6::parse(std::string_view text) {
    std::vector<std::uint16_t> head;
    std::vector<std::uint16_t> tail;
    std::size_t dc = text.find("::");
    if (dc != std::string_view::npos) {
        if (text.find("::", dc + 1) != std::string_view::npos) fail(text, "more than one '::'");
        parse_groups(text, text.substr(0, dc), false, head);
        parse_groups(text, text.substr(dc + 2), true, tail);
        if (head.size() + tail.size() > 7) fail(text, "too many groups");
    } else {
        parse_groups(text, text, true, head);
        if (head.size() != 8) fail(text, "need eight groups");
    }
    Ipv6 ip;
    for (std::size_t i = 0; i < head.size(); ++i) ip.groups[i] = head[i];
    for (std::size_t i = 0; i < tail.size(); ++i) ip.groups[8 - tail.size() + i] = tail[i];
    return ip;
}

bool Ipv6::is_v4_mapped() const {
    for (int i = 0; i < 5; ++i) {
        if (groups[static_cast<std::size_t>(i)] != 0) return false;
    }
    return groups[5] == 0xffff;
}

std::string Ipv6::str() const {
    int count = 8;
    std::string v4;
    if (is_v4_mapped()) {
        count = 6;
        v4 = Ipv4{(std::uint32_t{groups[6]} << 16) | groups[7]}.str();
    }
    int best_start = -1;
    int best_len = 0;
    for (int i = 0; i < count;) {
        if (groups[static_cast<std::size_t>(i)] != 0) {
            ++i;
            continue;
        }
        int j = i;
        while (j < count && groups[static_cast<std::size_t>(j)] == 0) ++j;
        if (best_start < 0 && j - i >= 2) {
            best_start = i;
            best_len = j - i;
        }
        i = j;
    }
    std::string out;
    char buf[8];
    for (int i = 0; i < count; ++i) {
        if (i == best_start) {
            out += "::";
            i += best_len - 1;
            continue;
        }
        if (!out.empty() && out.back() != ':') out += ':';
        std::snprintf(buf, sizeof buf, "%x", groups[static_cast<std::size_t>(i)]);
        out += buf;
    }
    if (!v4.empty()) {
        if (!out.empty() && out.back() != ':') out += ':';
        out += v4;
    }
    return out;
}

}  // namespace netcalc
