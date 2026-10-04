// netcalc: print details of IPv4 prefixes, canonicalize IPv6 addresses, or summarize ranges.
//
//   netcalc 192.168.1.10/24
//   netcalc 2001:0db8::0001
//   netcalc 10.0.0.1-10.0.0.6

#include <iostream>
#include <string>

#include "netcalc/ipv4.hpp"
#include "netcalc/ipv6.hpp"

using namespace netcalc;

int main(int argc, char** argv) {
    int status = 0;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        try {
            if (arg.find(':') != std::string::npos) {
                std::cout << Ipv6::parse(arg).str() << "\n";
            } else if (auto dash = arg.find('-'); dash != std::string::npos) {
                for (const auto& p : summarize(Ipv4::parse(arg.substr(0, dash)), Ipv4::parse(arg.substr(dash + 1)))) {
                    std::cout << p.str() << "\n";
                }
            } else {
                const Prefix4 p = Prefix4::parse(arg);
                std::cout << "prefix     " << p.str() << "\n"
                          << "netmask    " << Ipv4{p.mask()}.str() << "\n"
                          << "broadcast  " << p.broadcast().str() << "\n"
                          << "hosts      " << p.first_host().str() << " - " << p.last_host().str() << " ("
                          << p.usable_hosts() << ")\n";
            }
        } catch (const std::exception& e) {
            std::cerr << "netcalc: " << e.what() << "\n";
            status = 1;
        }
    }
    return status;
}
