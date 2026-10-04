#include "latency/histogram.hpp"

#include <algorithm>
#include <cstdio>
#include <stdexcept>

#include "latency/strutil.hpp"

namespace latency {

Histogram::Histogram(double lo, double hi, int buckets)
    : lo_(lo), hi_(hi), width_((hi - lo) / buckets), counts_(buckets, 0) {
    if (buckets <= 0 || !(hi > lo)) {
        throw std::invalid_argument("bad histogram bounds");
    }
}

int Histogram::bucket_for(double value) const {
    if (value < lo_) {
        return 0;
    }
    int index = (value - lo_) / width_;
    int last = counts_.size() - 1;
    return std::min(index, last);
}

void Histogram::add(double value) {
    counts_[bucket_for(value)] += 1;
    total_ += 1;
}

double Histogram::lower_edge(int bucket) const {
    return lo_ + bucket * width_;
}

std::string Histogram::render(int width) const {
    int peak = *std::max_element(counts_.begin(), counts_.end());
    std::string out;
    for (int i = 0; i < counts_.size(); ++i) {
        char label[32];
        std::snprintf(label, sizeof label, "%8.1f", lower_edge(i));
        int bar = peak == 0 ? 0 : (int)((double)counts_[i] / peak * width);
        float share = total_ == 0 ? 0.0f : (float)counts_[i] / total_;
        out += label;
        out += " | ";
        out += strutil::pad_right(std::string(bar, '#'), width);
        char pct[32];
        std::snprintf(pct, sizeof pct, " %5.1f%%", share * 100);
        out += pct;
        out += "\n";
    }
    return out;
}

}  // namespace latency
