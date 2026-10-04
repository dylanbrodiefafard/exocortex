#include "netcalc/ipv4.hpp"

#include <cstdlib>
#include <sstream>

namespace netcalc {

namespace {

bool parse_octet(std::string_view part, std::uint32_t& out) {
    if (part.empty() || part.size() > 3) {
        return false;
    }
    const std::string digits(part);
    char* end = nullptr;
    const unsigned long v = std::strtoul(digits.c_str(), &end, 10);
    if (end == digits.c_str() || *end != '\0' || v > 255) {
        return false;
    }
    out = static_cast<std::uint32_t>(v);
    return true;
}

std::uint32_t mask_for(int len) {
    return len == 0 ? 0u : ~std::uint32_t{0} << (32 - len);
}

}  // namespace

std::optional<Ipv4> Ipv4::try_parse(std::string_view text) {
    std::uint32_t value = 0;
    std::size_t start = 0;
    for (int i = 0; i < 4; ++i) {
        std::size_t dot = text.find('.', start);
        if ((i < 3) != (dot != std::string_view::npos)) {
            return std::nullopt;
        }
        std::string_view part = text.substr(start, i < 3 ? dot - start : std::string_view::npos);
        std::uint32_t octet = 0;
        if (!parse_octet(part, octet)) {
            return std::nullopt;
        }
        value = (value << 8) | octet;
        start = dot + 1;
    }
    return Ipv4{value};
}

Ipv4 Ipv4::parse(std::string_view text) {
    auto ip = try_parse(text);
    if (!ip) {
        throw ParseError("invalid IPv4 address: '" + std::string(text) + "'");
    }
    return *ip;
}

std::string Ipv4::str() const {
    std::ostringstream out;
    out << (value >> 24) << '.' << ((value >> 16) & 0xff) << '.' << ((value >> 8) & 0xff) << '.' << (value & 0xff);
    return out.str();
}

Prefix4 Prefix4::parse(std::string_view text) {
    std::size_t slash = text.find('/');
    if (slash == std::string_view::npos) {
        throw ParseError("missing prefix length: '" + std::string(text) + "'");
    }
    Prefix4 p;
    p.addr = Ipv4::parse(text.substr(0, slash));
    std::string_view len = text.substr(slash + 1);
    if (len.empty() || len.size() > 2 || (len.size() == 2 && len[0] == '0')) {
        throw ParseError("invalid prefix length: '" + std::string(text) + "'");
    }
    int n = 0;
    for (char c : len) {
        if (c < '0' || c > '9') {
            throw ParseError("invalid prefix length: '" + std::string(text) + "'");
        }
        n = n * 10 + (c - '0');
    }
    if (n > 32) {
        throw ParseError("prefix length out of range: '" + std::string(text) + "'");
    }
    p.len = n;
    return p;
}

std::uint32_t Prefix4::mask() const { return mask_for(len); }

Ipv4 Prefix4::network() const { return Ipv4{addr.value & mask()}; }

Ipv4 Prefix4::broadcast() const { return Ipv4{addr.value | ~mask()}; }

std::uint64_t Prefix4::size() const { return std::uint64_t{1} << (32 - len); }

std::uint64_t Prefix4::usable_hosts() const {
    if (len == 32) {
        return 1;
    }
    return size() - 2;
}

Ipv4 Prefix4::first_host() const {
    if (len == 32) {
        return network();
    }
    return Ipv4{network().value + 1};
}

Ipv4 Prefix4::last_host() const {
    if (len == 32) {
        return broadcast();
    }
    return Ipv4{broadcast().value - 1};
}

bool Prefix4::contains(Ipv4 ip) const { return (ip.value & mask()) == network().value; }

bool Prefix4::contains(const Prefix4& other) const {
    return other.len >= len && contains(other.network());
}

std::string Prefix4::str() const { return network().str() + "/" + std::to_string(len); }

std::vector<Prefix4> summarize(Ipv4 first, Ipv4 last) {
    if (last < first) {
        throw std::invalid_argument("summarize: last < first");
    }
    std::vector<Prefix4> out;
    std::uint64_t cur = first.value;
    const std::uint64_t end = last.value;
    while (cur <= end) {
        int len = 32;
        while (len > 0) {
            std::uint64_t block = std::uint64_t{1} << (32 - (len - 1));
            if (cur % block != 0 || cur + block - 1 > end) {
                break;
            }
            --len;
        }
        out.push_back(Prefix4{Ipv4{static_cast<std::uint32_t>(cur)}, len});
        cur += std::uint64_t{1} << (32 - len);
    }
    return out;
}

}  // namespace netcalc
