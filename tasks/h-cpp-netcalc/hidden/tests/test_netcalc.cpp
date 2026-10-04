#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "netcalc/ipv4.hpp"
#include "netcalc/ipv6.hpp"
#include "tap.hpp"

using namespace netcalc;

namespace {

std::string dotted(std::uint64_t v) {
    return std::to_string((v >> 24) & 0xff) + "." + std::to_string((v >> 16) & 0xff) + "." +
           std::to_string((v >> 8) & 0xff) + "." + std::to_string(v & 0xff);
}

std::string join(const std::vector<Prefix4>& ps) {
    std::string out;
    for (const auto& p : ps) {
        if (!out.empty()) out += " ";
        out += p.str();
    }
    return out;
}

const char* const kAddresses[] = {
    "0.0.0.0",       "10.0.0.1",     "10.1.2.3",      "100.64.17.250", "127.0.0.1",     "169.254.1.77",
    "172.16.255.254", "192.0.2.128", "192.168.100.37", "198.51.100.7", "203.0.113.255", "224.0.0.251",
    "240.15.3.9",    "8.8.4.4",      "1.1.1.1",       "255.255.255.255", "77.88.99.111", "11.22.33.44",
};

void prefix_matrix() {
    tap::section("prefix4 matrix");
    for (const char* text : kAddresses) {
        const std::uint64_t a = Ipv4::parse(text).value;
        for (int len = 0; len <= 32; ++len) {
            const std::uint64_t size = std::uint64_t{1} << (32 - len);
            const std::uint64_t net = a / size * size;
            const std::uint64_t last = net + size - 1;
            const std::uint64_t usable = len == 32 ? 1 : len == 31 ? 2 : size - 2;
            const std::uint64_t first_host = len >= 31 ? net : net + 1;
            const std::uint64_t last_host = len >= 31 ? last : last - 1;
            const Prefix4 p = Prefix4::parse(std::string(text) + "/" + std::to_string(len));
            const std::string tag = std::string(text) + "/" + std::to_string(len);
            tap::eq(p.network().str(), dotted(net), "network(" + tag + ")");
            tap::eq(p.broadcast().str(), dotted(last), "broadcast(" + tag + ")");
            tap::eq(p.size(), size, "size(" + tag + ")");
            tap::eq(p.usable_hosts(), usable, "usable_hosts(" + tag + ")");
            tap::eq(p.first_host().str(), dotted(first_host), "first_host(" + tag + ")");
            tap::eq(p.last_host().str(), dotted(last_host), "last_host(" + tag + ")");
            tap::truth(p.contains(Ipv4::parse(text)), "contains(" + tag + ", " + text + ")");
            tap::eq(p.str(), dotted(net) + "/" + std::to_string(len), "str(" + tag + ")");
        }
    }
}

void ipv4_parse() {
    tap::section("ipv4 parse");
    const char* const valid[] = {"0.0.0.0", "1.2.3.4", "255.255.255.255", "10.0.0.10", "192.168.1.100", "9.99.199.249"};
    for (const char* text : valid) {
        auto ip = Ipv4::try_parse(text);
        tap::truth(ip.has_value(), std::string("accepts ") + text);
        tap::eq(ip ? ip->str() : std::string("<none>"), std::string(text), std::string("round trip ") + text);
    }
    const char* const invalid[] = {
        "",          "1.2.3",     "1.2.3.4.5", "256.1.1.1", "1.2.3.256", "1.2.3.999", "1..3.4",   "1.2.3.",
        ".1.2.3",    "a.b.c.d",   "1.2.3.4a",  "01.2.3.4",  "1.02.3.4",  "1.2.3.00", "1.2.3.+4", "1.2.3.-0",
        "1.2. 3.4",  "1.2.3.4 ",  " 1.2.3.4",  "1.2.3.0x1", "1.2.3.4/8", "1234.1.1.1", "1,2,3,4",
        "00.1.2.3",  "1.2.3.04",  "1.2.3.+0",  "+1.2.3.4",  "1.2.3.\t4", "1.2.3.\n4", "1.-0.3.4", "010.010.010.010",
    };
    for (const char* text : invalid) {
        tap::truth(!Ipv4::try_parse(text).has_value(), std::string("rejects '") + text + "'");
    }
    bool threw = false;
    try {
        Ipv4::parse("300.1.1.1");
    } catch (const ParseError&) {
        threw = true;
    }
    tap::truth(threw, "parse throws ParseError");
    const char* const bad_prefixes[] = {"1.2.3.4", "1.2.3.4/", "1.2.3.4/33", "1.2.3.4/08", "1.2.3.4/x", "01.2.3.4/8", "1.2.3.4/-1"};
    for (const char* text : bad_prefixes) {
        bool t = false;
        try {
            Prefix4::parse(text);
        } catch (const ParseError&) {
            t = true;
        }
        tap::truth(t, std::string("Prefix4 rejects '") + text + "'");
    }
}

void ipv6_cases() {
    tap::section("ipv6 format");
    struct Case {
        const char* in;
        const char* canonical;
    };
    const Case cases[] = {
        {"::", "::"},
        {"::1", "::1"},
        {"1::", "1::"},
        {"2001:db8::1", "2001:db8::1"},
        {"2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"},
        {"2001:DB8:0:0:0:0:2:1", "2001:db8::2:1"},
        {"2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"},
        {"2001:db8:0:0:1:0:0:0", "2001:db8:0:0:1::"},
        {"2001:0:0:1:0:0:0:1", "2001:0:0:1::1"},
        {"2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"},
        {"0:0:1:0:0:0:0:0", "0:0:1::"},
        {"1:0:0:0:1:0:0:0", "1::1:0:0:0"},
        {"0:0:0:1:0:0:0:0", "0:0:0:1::"},
        {"fe80::0:0:1", "fe80::1"},
        {"FE80:0000:0000:0000:0202:B3FF:FE1E:8329", "fe80::202:b3ff:fe1e:8329"},
        {"1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"},
        {"1:2:3:4:5:6::", "1:2:3:4:5:6::"},
        {"1:2:3:4:5::8", "1:2:3:4:5::8"},
        {"1:2:3:4:5:6:0:8", "1:2:3:4:5:6:0:8"},
        {"0:1:0:1:0:1:0:1", "0:1:0:1:0:1:0:1"},
        {"1:0:0:2:0:0:3:4", "1::2:0:0:3:4"},
        {"1:0:0:2:0:0:0:4", "1:0:0:2::4"},
        {"0:0:a:0:0:0:b:0", "0:0:a::b:0"},
        {"abcd:ef01:2345:6789:abcd:ef01:2345:6789", "abcd:ef01:2345:6789:abcd:ef01:2345:6789"},
        {"::ffff:192.0.2.1", "::ffff:192.0.2.1"},
        {"0:0:0:0:0:ffff:c000:0201", "::ffff:192.0.2.1"},
        {"::ffff:0.0.0.0", "::ffff:0.0.0.0"},
        {"64:ff9b::192.0.2.33", "64:ff9b::c000:221"},
        {"::192.0.2.33", "::c000:221"},
        {"2001:db8:aaaa:bbbb:cccc:dddd:eeee:0001", "2001:db8:aaaa:bbbb:cccc:dddd:eeee:1"},
        {"2001:db8::aaaa:0:0:1", "2001:db8::aaaa:0:0:1"},
        {"2001:db8:0:0:aaaa::1", "2001:db8::aaaa:0:0:1"},
        {"0:0:1:0:0:1:0:0", "::1:0:0:1:0:0"},
        {"1:0:1:0:0:0:1:0", "1:0:1::1:0"},
        {"a:0:0:b:0:0:0:0", "a:0:0:b::"},
        {"0:0:0:0:1:0:0:0", "::1:0:0:0"},
        {"1:0:0:1:0:0:0:1", "1:0:0:1::1"},
        {"0:0:1:0:0:0:1:0", "0:0:1::1:0"},
        {"1:0:2:0:3:0:0:4", "1:0:2:0:3::4"},
    };
    for (const Case& c : cases) {
        std::string got;
        try {
            got = Ipv6::parse(c.in).str();
        } catch (const std::exception& e) {
            got = std::string("<error: ") + e.what() + ">";
        }
        tap::eq(got, std::string(c.canonical), std::string("str(parse(\"") + c.in + "\"))");
    }
    const char* const invalid[] = {
        "",           ":",           ":::",          "1:2:3:4:5:6:7",    "1:2:3:4:5:6:7:8:9", "1::2::3",
        "12345::",    "g::",         "1:2:3:4:5:6:7::8", "::1.2.3",      "::1.2.3.256",       "::ffff:01.2.3.4",
        "1.2.3.4::",  "2001:db8:::1", "1:2:3:4:5:6:7:8::", "::ffff:1.2.3.04", "::1.2.3.+4", "::ffff: 1.2.3.4",
    };
    for (const char* text : invalid) {
        bool threw = false;
        try {
            Ipv6::parse(text);
        } catch (const ParseError&) {
            threw = true;
        }
        tap::truth(threw, std::string("rejects '") + text + "'");
    }
}

void containment_matrix() {
    tap::section("prefix containment");
    const char* const prefixes[] = {
        "0.0.0.0/0",     "10.0.0.0/8",    "10.0.0.0/16",   "10.0.1.0/24",  "10.0.0.0/31",     "10.0.0.1/32",
        "10.255.0.0/16", "11.0.0.0/8",    "172.16.0.0/12", "172.31.0.0/16", "192.168.0.0/16", "192.168.4.0/22",
        "192.168.7.0/24", "192.168.8.0/24", "192.168.7.128/25", "255.255.255.255/32",
    };
    for (const char* outer_text : prefixes) {
        const Prefix4 outer = Prefix4::parse(outer_text);
        for (const char* inner_text : prefixes) {
            const Prefix4 inner = Prefix4::parse(inner_text);
            const std::uint64_t lo = inner.network().value;
            const std::uint64_t hi = lo + inner.size() - 1;
            const std::uint64_t olo = outer.network().value;
            const std::uint64_t ohi = olo + outer.size() - 1;
            const bool expected = olo <= lo && hi <= ohi;
            tap::eq(outer.contains(inner), expected,
                    std::string("contains(") + outer_text + ", " + inner_text + ")");
        }
    }
}

void summarize_cases() {
    tap::section("summarize");
    struct Case {
        const char* first;
        const char* last;
        const char* expected;
    };
    const Case cases[] = {
        {"10.0.0.0", "10.0.0.255", "10.0.0.0/24"},
        {"10.0.0.1", "10.0.0.1", "10.0.0.1/32"},
        {"10.0.0.0", "10.0.0.1", "10.0.0.0/31"},
        {"10.0.0.1", "10.0.0.2", "10.0.0.1/32 10.0.0.2/32"},
        {"10.0.0.1", "10.0.0.6", "10.0.0.1/32 10.0.0.2/31 10.0.0.4/31 10.0.0.6/32"},
        {"192.168.1.10", "192.168.1.200", "192.168.1.10/31 192.168.1.12/30 192.168.1.16/28 192.168.1.32/27 "
                                          "192.168.1.64/26 192.168.1.128/26 192.168.1.192/29 192.168.1.200/32"},
        {"0.0.0.0", "255.255.255.255", "0.0.0.0/0"},
        {"0.0.0.0", "127.255.255.255", "0.0.0.0/1"},
        {"128.0.0.0", "255.255.255.255", "128.0.0.0/1"},
        {"255.255.255.254", "255.255.255.255", "255.255.255.254/31"},
        {"255.255.255.255", "255.255.255.255", "255.255.255.255/32"},
        {"1.0.0.0", "1.0.255.255", "1.0.0.0/16"},
        {"172.16.0.0", "172.31.255.255", "172.16.0.0/12"},
        {"10.0.0.255", "10.0.1.0", "10.0.0.255/32 10.0.1.0/32"},
        {"0.0.0.1", "255.255.255.254",
         "0.0.0.1/32 0.0.0.2/31 0.0.0.4/30 0.0.0.8/29 0.0.0.16/28 0.0.0.32/27 0.0.0.64/26 0.0.0.128/25 0.0.1.0/24 "
         "0.0.2.0/23 0.0.4.0/22 0.0.8.0/21 0.0.16.0/20 0.0.32.0/19 0.0.64.0/18 0.0.128.0/17 0.1.0.0/16 0.2.0.0/15 "
         "0.4.0.0/14 0.8.0.0/13 0.16.0.0/12 0.32.0.0/11 0.64.0.0/10 0.128.0.0/9 1.0.0.0/8 2.0.0.0/7 4.0.0.0/6 "
         "8.0.0.0/5 16.0.0.0/4 32.0.0.0/3 64.0.0.0/2 128.0.0.0/2 192.0.0.0/3 224.0.0.0/4 240.0.0.0/5 248.0.0.0/6 "
         "252.0.0.0/7 254.0.0.0/8 255.0.0.0/9 255.128.0.0/10 255.192.0.0/11 255.224.0.0/12 255.240.0.0/13 "
         "255.248.0.0/14 255.252.0.0/15 255.254.0.0/16 255.255.0.0/17 255.255.128.0/18 255.255.192.0/19 "
         "255.255.224.0/20 255.255.240.0/21 255.255.248.0/22 255.255.252.0/23 255.255.254.0/24 255.255.255.0/25 "
         "255.255.255.128/26 255.255.255.192/27 255.255.255.224/28 255.255.255.240/29 255.255.255.248/30 "
         "255.255.255.252/31 255.255.255.254/32"},
    };
    for (const Case& c : cases) {
        tap::eq(join(summarize(Ipv4::parse(c.first), Ipv4::parse(c.last))), std::string(c.expected),
                std::string("summarize(") + c.first + ", " + c.last + ")");
    }
    bool threw = false;
    try {
        summarize(Ipv4::parse("10.0.0.2"), Ipv4::parse("10.0.0.1"));
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    tap::truth(threw, "summarize rejects reversed range");
}

}  // namespace

int main() {
    prefix_matrix();
    ipv4_parse();
    ipv6_cases();
    containment_matrix();
    summarize_cases();
    return tap::finish();
}
