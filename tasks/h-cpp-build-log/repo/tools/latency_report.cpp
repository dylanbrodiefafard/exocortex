// latency_report: summarize an access-log CSV.
//
//   latency_report access.csv [--histogram]

#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>

#include "latency/histogram.hpp"
#include "latency/report.hpp"
#include "latency/strutil.hpp"

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: " << argv[0] << " FILE [--histogram]\n";
        return 2;
    }
    std::ifstream in(argv[1], std::ios::binary);
    if (!in) {
        std::cerr << "cannot open " << argv[1] << "\n";
        return 1;
    }
    std::stringstream buffer;
    buffer << in.rdbuf();
    int rejected = 0;
    std::vector<latency::Record> records = latency::read_records(buffer.str(), &rejected);
    std::vector<latency::EndpointStats> rows = latency::summarize(records);
    std::cout << latency::render_table(rows);
    if (rejected > 0) {
        std::cout << rejected << " malformed rows skipped\n";
    }
    bool histogram = argc > 2 && std::strcmp(argv[2], "--histogram") == 0;
    if (histogram) {
        latency::Histogram h(0, 1000, 20);
        for (const latency::Record& r : records) {
            h.add(r.duration_ms);
        }
        std::cout << "\n" << h.render();
    }
    for (const auto& [agent, count] : latency::requests_by_agent(records)) {
        int width = 60;
        std::cout << latency::strutil::pad_right(agent.substr(0, width), width) << " " << count << "\n";
    }
    return 0;
}
