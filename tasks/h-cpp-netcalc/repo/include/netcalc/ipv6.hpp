#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

#include "netcalc/ipv4.hpp"

namespace netcalc {

// An IPv6 address as eight 16-bit groups.
struct Ipv6 {
    std::array<std::uint16_t, 8> groups{};

    // Accepts the RFC 4291 text forms: eight groups of 1-4 hex digits (any case), at most
    // one "::" standing for one or more zero groups, and an optional dotted-quad IPv4
    // address in place of the last two groups. Throws ParseError.
    static Ipv6 parse(std::string_view text);

    // RFC 5952 canonical text: lowercase, leading zeros dropped, the longest run of two or
    // more zero groups replaced by "::" (the first such run if there is a tie), a lone zero
    // group never compressed. IPv4-mapped addresses (::ffff:0:0/96) print the last 32 bits
    // as a dotted quad.
    std::string str() const;

    bool is_v4_mapped() const;

    friend bool operator==(const Ipv6& a, const Ipv6& b) { return a.groups == b.groups; }
    friend bool operator!=(const Ipv6& a, const Ipv6& b) { return a.groups != b.groups; }
};

}  // namespace netcalc
