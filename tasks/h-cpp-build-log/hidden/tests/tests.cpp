#include <cmath>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "check.hpp"
#include "latency/csv.hpp"
#include "latency/histogram.hpp"
#include "latency/record.hpp"
#include "latency/report.hpp"
#include "latency/stats.hpp"
#include "latency/strutil.hpp"

using namespace latency;

namespace {

const char* const kEndpoints[][2] = {
    {"GET", "/api/orders"}, {"GET", "/api/orders/{id}"}, {"POST", "/api/orders"},
    {"GET", "/api/products"}, {"DELETE", "/api/cart/{id}"}, {"GET", "/healthz"},
};

const char* const kAgents[] = {
    "curl/8.4.0",
    "\"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36\"",
    "\"python-requests/2.31.0\"",
    "\"Go-http-client/1.1\"",
};

// Deterministic synthetic access log with a header row.
std::string synthetic_log(int rows) {
    std::ostringstream out;
    out << "timestamp,method,path,status,duration_ms,user_agent\n";
    for (int i = 0; i < rows; ++i) {
        const auto& ep = kEndpoints[(i * 7) % 6];
        int status = (i % 23 == 0) ? 503 : (i % 11 == 0) ? 404 : 200;
        long duration = (i * 37L) % 480 + (ep[1][5] == 'o' ? 20 : 3);
        out << 1767225600L + i * 3 << "," << ep[0] << "," << ep[1] << "," << status << "," << duration << ","
            << kAgents[i % 4] << "\n";
        if (i % 50 == 49) {
            out << "# rotated\n\n";
        }
    }
    return out.str();
}

}  // namespace

TEST_CASE("strutil: trim") {
    EXPECT_EQ(strutil::trim("  hello \t"), "hello");
    EXPECT_EQ(strutil::trim(""), "");
    EXPECT_EQ(strutil::trim("   "), "");
    EXPECT_EQ(strutil::trim("x"), "x");
}

TEST_CASE("strutil: split") {
    auto parts = strutil::split("a,b,,c", ',');
    EXPECT_EQ(parts.size(), 4u);
    EXPECT_EQ(parts[0], "a");
    EXPECT_EQ(parts[2], "");
    EXPECT_EQ(parts[3], "c");
    EXPECT_EQ(strutil::split("", ',').size(), 1u);
}

TEST_CASE("strutil: padding and case") {
    EXPECT_EQ(strutil::pad_right("ab", 4), "ab  ");
    EXPECT_EQ(strutil::pad_left("ab", 4), "  ab");
    EXPECT_EQ(strutil::pad_right("abcdef", 4), "abcdef");
    EXPECT_EQ(strutil::to_lower("GET /API"), "get /api");
    EXPECT_EQ(strutil::starts_with("/api/orders", "/api"), true);
    EXPECT_EQ(strutil::starts_with("/a", "/api"), false);
    EXPECT_EQ(strutil::format_ms(12.345), "12.3 ms");
    EXPECT_EQ(strutil::format_ms(2, 0), "2 ms");
    EXPECT_EQ(strutil::display_width("caf\xC3\xA9"), 4);
}

TEST_CASE("csv: plain fields") {
    auto f = csv::split_line("1,GET,/x,200");
    EXPECT_EQ(f.size(), 4u);
    EXPECT_EQ(f[1], "GET");
    EXPECT_EQ(f[3], "200");
}

TEST_CASE("csv: empty fields") {
    auto f = csv::split_line(",a,,");
    EXPECT_EQ(f.size(), 4u);
    EXPECT_EQ(f[0], "");
    EXPECT_EQ(f[1], "a");
    EXPECT_EQ(f[3], "");
}

TEST_CASE("csv: quoted field with commas") {
    auto f = csv::split_line("1,\"Mozilla/5.0 (X11, Linux)\",2");
    EXPECT_EQ(f.size(), 3u);
    EXPECT_EQ(f[1], "Mozilla/5.0 (X11, Linux)");
    EXPECT_EQ(f[2], "2");
}

TEST_CASE("csv: doubled quotes inside a quoted field") {
    auto f = csv::split_line("7,\"say \"\"hi\"\", ok\",x");
    EXPECT_EQ(f.size(), 3u);
    EXPECT_EQ(f[1], "say \"hi\", ok");
    EXPECT_EQ(f[2], "x");
}

TEST_CASE("csv: unterminated quote") {
    EXPECT_THROWS(csv::ParseError, csv::split_line("1,\"abc,2"));
}

TEST_CASE("csv: reader skips blanks and comments") {
    std::istringstream in("# header comment\r\na,b\r\n\r\nc,d\n# trailing\n");
    csv::Reader reader(in);
    std::vector<std::string> fields;
    EXPECT_TRUE(reader.next(fields));
    EXPECT_EQ(fields[1], "b");
    EXPECT_EQ(reader.line_number(), 2);
    EXPECT_TRUE(reader.next(fields));
    EXPECT_EQ(fields[0], "c");
    EXPECT_EQ(reader.line_number(), 4);
    EXPECT_EQ(reader.next(fields), false);
}

TEST_CASE("record: parse") {
    Record r = parse_record({"1767225600", " GET", "/api/orders ", "200", "35", "curl/8.4.0"});
    EXPECT_EQ(r.timestamp, 1767225600L);
    EXPECT_EQ(r.endpoint(), "GET /api/orders");
    EXPECT_EQ(r.status, 200);
    EXPECT_EQ(r.duration_ms, 35L);
    EXPECT_EQ(r.is_error(), false);
}

TEST_CASE("record: rejects malformed rows") {
    EXPECT_THROWS(std::invalid_argument, parse_record({"1", "GET", "/x", "200", "5"}));
    EXPECT_THROWS(std::invalid_argument, parse_record({"1", "GET", "/x", "abc", "5", "ua"}));
    EXPECT_THROWS(std::invalid_argument, parse_record({"1", "GET", "/x", "700", "5", "ua"}));
    EXPECT_THROWS(std::invalid_argument, parse_record({"1", "GET", "/x", "200", "-5", "ua"}));
    EXPECT_THROWS(std::invalid_argument, parse_record({"", "GET", "/x", "200", "5", "ua"}));
    EXPECT_THROWS(std::invalid_argument, parse_record({"12x", "GET", "/x", "200", "5", "ua"}));
}

TEST_CASE("record: user agents keep embedded quotes") {
    std::string text =
        "timestamp,method,path,status,duration_ms,user_agent\n"
        "1,GET,/a,200,5,\"Mozilla/5.0 (compatible; \"\"ExampleBot\"\"/2.1; +https://example.com/bot)\"\n"
        "2,GET,/a,200,6,curl/8.4.0\n";
    int rejected = -1;
    auto records = read_records(text, &rejected);
    EXPECT_EQ(rejected, 0);
    EXPECT_EQ(records.size(), 2u);
    auto agents = requests_by_agent(records);
    EXPECT_EQ(agents.count("Mozilla/5.0 (compatible; \"ExampleBot\"/2.1; +https://example.com/bot)"), 1u);
}

TEST_CASE("stats: mean") {
    EXPECT_EQ(stats::mean(std::vector<int>{1, 2, 3, 4}), 2.5);
    EXPECT_EQ(stats::mean(std::vector<double>{}), 0.0);
    EXPECT_EQ(stats::mean(std::vector<double>{0.5, 1.5}), 1.0);
}

TEST_CASE("stats: nearest-rank percentile") {
    std::vector<int> v{15, 20, 35, 40, 50};
    EXPECT_EQ(stats::percentile(v, 5), 15);
    EXPECT_EQ(stats::percentile(v, 30), 20);
    EXPECT_EQ(stats::percentile(v, 40), 20);
    EXPECT_EQ(stats::percentile(v, 50), 35);
    EXPECT_EQ(stats::percentile(v, 100), 50);
    EXPECT_EQ(stats::percentile(std::vector<double>{3.5}, 99), 3.5);
    EXPECT_THROWS(std::invalid_argument, stats::percentile(std::vector<int>{}, 50));
    EXPECT_THROWS(std::invalid_argument, stats::percentile(v, 0));
    EXPECT_THROWS(std::invalid_argument, stats::percentile(v, 101));
}

TEST_CASE("stats: percentile sweep") {
    std::vector<int> v;
    for (int i = 1; i <= 100; ++i) {
        v.push_back(i);
    }
    for (int p = 1; p <= 100; ++p) {
        EXPECT_EQ(stats::percentile(v, p), p);
    }
}

TEST_CASE("histogram: buckets") {
    Histogram h(0, 100, 10);
    EXPECT_EQ(h.buckets(), 10);
    EXPECT_EQ(h.bucket_for(-5), 0);
    EXPECT_EQ(h.bucket_for(0), 0);
    EXPECT_EQ(h.bucket_for(9.99), 0);
    EXPECT_EQ(h.bucket_for(10), 1);
    EXPECT_EQ(h.bucket_for(99.9), 9);
    EXPECT_EQ(h.bucket_for(100), 9);
    EXPECT_EQ(h.bucket_for(1e9), 9);
    EXPECT_EQ(h.lower_edge(3), 30.0);
    EXPECT_THROWS(std::invalid_argument, Histogram(5, 5, 3));
}

TEST_CASE("histogram: counts and render") {
    Histogram h(0, 40, 4);
    for (int v : {1, 2, 3, 15, 25, 26, 39, 120}) {
        h.add(v);
    }
    EXPECT_EQ(h.total(), 8);
    EXPECT_EQ(h.count(0), 3);
    EXPECT_EQ(h.count(1), 1);
    EXPECT_EQ(h.count(2), 2);
    EXPECT_EQ(h.count(3), 2);
    std::string chart = h.render(6);
    EXPECT_EQ(chart.substr(0, 25), "     0.0 | ######  37.5%\n");
}

TEST_CASE("report: summarize synthetic log") {
    int rejected = -1;
    auto records = read_records(synthetic_log(600), &rejected);
    EXPECT_EQ(rejected, 0);
    EXPECT_EQ(records.size(), 600u);
    auto rows = summarize(records);
    EXPECT_EQ(rows.size(), 6u);
    int total = 0;
    for (const EndpointStats& row : rows) {
        total += row.requests;
        EXPECT_EQ(row.requests, 100);
        EXPECT_TRUE(row.p50_ms <= row.p95_ms);
        EXPECT_TRUE(row.p95_ms <= row.max_ms);
        EXPECT_TRUE(row.mean_ms > 0);
    }
    EXPECT_EQ(total, 600);
    EXPECT_EQ(rows[0].endpoint, "DELETE /api/cart/{id}");
    EXPECT_EQ(rows[5].endpoint, "POST /api/orders");
}

TEST_CASE("report: per-endpoint numbers") {
    auto rows = summarize(read_records(synthetic_log(600)));
    const long expected[][5] = {
        // errors, p50, p95, max, mean x10
        {5, 235, 451, 481, 2392}, {5, 248, 470, 494, 2570}, {4, 249, 471, 495, 2556},
        {4, 234, 450, 480, 2358}, {5, 236, 452, 482, 2426}, {4, 250, 472, 496, 2542},
    };
    EXPECT_EQ(rows.size(), 6u);
    for (size_t i = 0; i < rows.size() && i < 6; ++i) {
        EXPECT_EQ(rows[i].errors, expected[i][0]);
        EXPECT_EQ(rows[i].p50_ms, expected[i][1]);
        EXPECT_EQ(rows[i].p95_ms, expected[i][2]);
        EXPECT_EQ(rows[i].max_ms, expected[i][3]);
        EXPECT_EQ(std::lround(rows[i].mean_ms * 10), expected[i][4]);
    }
}

TEST_CASE("report: agents") {
    auto agents = requests_by_agent(read_records(synthetic_log(600)));
    EXPECT_EQ(agents.size(), 4u);
    EXPECT_EQ(agents["curl/8.4.0"], 150);
    EXPECT_EQ(agents["python-requests/2.31.0"], 150);
    EXPECT_EQ(agents["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"], 150);
}

TEST_CASE("report: table") {
    std::vector<EndpointStats> rows(2);
    rows[0] = {"GET /api/orders", 10, 1, 12.25, 10, 30, 31};
    rows[1] = {"GET /healthz", 3, 0, 1.0, 1, 1, 1};
    std::string table = render_table(rows);
    std::istringstream lines(table);
    std::string header, first, second;
    std::getline(lines, header);
    std::getline(lines, first);
    std::getline(lines, second);
    EXPECT_EQ(header, "endpoint         reqs  errs     mean    p50    p95    max");
    EXPECT_EQ(first, "GET /api/orders    10     1     12.2     10     30     31");
    EXPECT_EQ(second, "GET /healthz        3     0      1.0      1      1      1");
}

TEST_CASE("csv: quoting edge cases") {
    auto only_quote = csv::split_line("\"\"\"\"");
    EXPECT_EQ(only_quote.size(), 1u);
    EXPECT_EQ(only_quote[0], "\"");

    auto empty_quoted = csv::split_line("\"\",x,\"\"");
    EXPECT_EQ(empty_quoted.size(), 3u);
    EXPECT_EQ(empty_quoted[0], "");
    EXPECT_EQ(empty_quoted[1], "x");
    EXPECT_EQ(empty_quoted[2], "");

    auto trailing = csv::split_line("\"a\"\"b\"\"\",c");
    EXPECT_EQ(trailing.size(), 2u);
    EXPECT_EQ(trailing[0], "a\"b\"");
    EXPECT_EQ(trailing[1], "c");

    auto leading = csv::split_line("\"\"\"quoted\"\" start\",1");
    EXPECT_EQ(leading.size(), 2u);
    EXPECT_EQ(leading[0], "\"quoted\" start");

    auto commas = csv::split_line("\"a,\"\"b\"\",c\",\",\"");
    EXPECT_EQ(commas.size(), 2u);
    EXPECT_EQ(commas[0], "a,\"b\",c");
    EXPECT_EQ(commas[1], ",");
}

TEST_CASE("csv: quotes inside unquoted fields are literal") {
    auto f = csv::split_line("ab\"c,d\"\"e,f");
    EXPECT_EQ(f.size(), 3u);
    EXPECT_EQ(f[0], "ab\"c");
    EXPECT_EQ(f[1], "d\"\"e");
    EXPECT_EQ(f[2], "f");
    auto g = csv::split_line("5,12\" pipe,x");
    EXPECT_EQ(g.size(), 3u);
    EXPECT_EQ(g[1], "12\" pipe");
}

TEST_CASE("csv: unterminated quoted fields") {
    EXPECT_THROWS(csv::ParseError, csv::split_line("\"abc"));
    EXPECT_THROWS(csv::ParseError, csv::split_line("1,\"a\"\",b"));
    EXPECT_THROWS(csv::ParseError, csv::split_line("\""));
}

TEST_CASE("record: agents with quotes end to end") {
    std::string text =
        "timestamp,method,path,status,duration_ms,user_agent\n"
        "1,GET,/a,200,5,\"Bot \"\"X\"\", v1\"\r\n"
        "2,GET,/a,200,6,\"Bot \"\"X\"\", v1\"\n"
        "3,GET,/a,200,7,Weird\"Agent\n";
    int rejected = -1;
    auto records = read_records(text, &rejected);
    EXPECT_EQ(records.size(), 3u);
    EXPECT_EQ(rejected, 0);
    auto agents = requests_by_agent(records);
    EXPECT_EQ(agents["Bot \"X\", v1"], 2);
    EXPECT_EQ(agents["Weird\"Agent"], 1);
}

int main() {
    return check::run_all();
}
