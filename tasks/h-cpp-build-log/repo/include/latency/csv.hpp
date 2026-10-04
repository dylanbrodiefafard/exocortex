#pragma once

#include <istream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace latency::csv {

class ParseError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Splits one line of CSV (RFC 4180 style) into fields.
//
// Fields are separated by commas. A field that starts with a double quote is a
// quoted field: it ends at the matching closing quote, may contain commas, and
// a doubled quote ("") inside it stands for one literal quote character.
// A field that does not start with a quote is taken verbatim up to the next
// comma, including any quote characters in it.
//
// Throws ParseError if a quoted field is not terminated.
std::vector<std::string> split_line(std::string_view line);

// Reads CSV rows from a stream. Blank lines and lines starting with '#' are
// skipped, and a trailing '\r' is removed from every line.
class Reader {
public:
    explicit Reader(std::istream& in) : in_(in) {}

    // Reads the next row into `fields`; returns false at end of input.
    bool next(std::vector<std::string>& fields);

    // 1-based number of the last physical line read.
    int line_number() const { return line_number_; }

private:
    std::istream& in_;
    int line_number_ = 0;
};

}  // namespace latency::csv
