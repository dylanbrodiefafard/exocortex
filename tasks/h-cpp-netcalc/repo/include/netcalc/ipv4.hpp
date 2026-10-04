#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace netcalc {

struct ParseError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// An IPv4 address. Textual form is strict dotted-quad: exactly four decimal octets
// 0..255, each one to three digits with no leading zeros (except "0" itself), no sign,
// no whitespace.
struct Ipv4 {
    std::uint32_t value = 0;

    static Ipv4 parse(std::string_view text);  // throws ParseError
    static std::optional<Ipv4> try_parse(std::string_view text);
    std::string str() const;

    friend bool operator==(Ipv4 a, Ipv4 b) { return a.value == b.value; }
    friend bool operator!=(Ipv4 a, Ipv4 b) { return a.value != b.value; }
    friend bool operator<(Ipv4 a, Ipv4 b) { return a.value < b.value; }
};

// An IPv4 prefix "a.b.c.d/len" (len 0..32). The address may have host bits set;
// network() clears them and str() prints the canonical network form.
struct Prefix4 {
    Ipv4 addr;
    int len = 32;

    static Prefix4 parse(std::string_view text);  // throws ParseError

    std::uint32_t mask() const;
    Ipv4 network() const;
    Ipv4 broadcast() const;  // last address of the block
    std::uint64_t size() const;  // number of addresses, 1..2^32
    // Usable host addresses: size - 2 for len <= 30; 2 for /31 (RFC 3021); 1 for /32.
    std::uint64_t usable_hosts() const;
    // First and last usable host: network + 1 and broadcast - 1, except that every
    // address of a /31 or /32 is usable.
    Ipv4 first_host() const;
    Ipv4 last_host() const;
    bool contains(Ipv4 ip) const;
    bool contains(const Prefix4& other) const;  // other lies entirely inside this block
    std::string str() const;  // "network/len"
};

// The shortest list of prefixes, in ascending order, that covers exactly [first, last].
// Throws std::invalid_argument when last < first.
std::vector<Prefix4> summarize(Ipv4 first, Ipv4 last);

}  // namespace netcalc
