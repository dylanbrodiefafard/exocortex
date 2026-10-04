#pragma once

#include <string>
#include <vector>

namespace latency {

// Fixed-width histogram over [lo, hi). Values below lo go to the first bucket,
// values at or above hi go to the last bucket.
class Histogram {
public:
    Histogram(double lo, double hi, int buckets);

    void add(double value);
    int bucket_for(double value) const;
    int count(int bucket) const { return counts_.at(bucket); }
    int buckets() const { return counts_.size(); }
    int total() const { return total_; }
    double lower_edge(int bucket) const;

    // ASCII bar chart, one line per bucket, bars scaled to `width` characters.
    std::string render(int width = 40) const;

private:
    double lo_;
    double hi_;
    double width_;
    std::vector<int> counts_;
    int total_ = 0;
};

}  // namespace latency
