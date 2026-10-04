// Prints a latency histogram for a synthetic, long-tailed workload.

#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <iostream>
#include <vector>

#include "latency/csv.hpp"
#include "latency/histogram.hpp"
#include "latency/strutil.hpp"

namespace {

std::vector<double> workload(int n) {
    std::vector<double> out;
    unsigned state = 12345;
    for (int i = 0; i < n; ++i) {
        state = state * 1103515245 + 12345;
        float u = (state >> 8) / 16777216.0f;
        double ms = 20 + 15 * std::log(1 / (1 - u + 1e-9));
        out.push_back(ms);
    }
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    int n = argc > 1 ? std::atoi(argv[1]) : 5000;
    latency::Histogram h(0, 200, 20);
    for (double ms : workload(n)) {
        h.add(ms);
    }
    std::cout << h.render(50);
    for (const std::string& field : latency::csv::split_line("p50,p95,p99")) {
        int width = 6;
        std::cout << latency::strutil::pad_left(field, width);
    }
    std::cout << "\n";
    return 0;
}
