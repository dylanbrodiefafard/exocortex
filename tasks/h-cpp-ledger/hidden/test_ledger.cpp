// Minimal test runner: each TEST registers a function; main runs them all.
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "ledger.hpp"
#include "money.hpp"

using namespace bank;

static std::vector<std::pair<const char*, std::function<void()>>>& registry() {
    static std::vector<std::pair<const char*, std::function<void()>>> tests;
    return tests;
}
static int failures = 0;

struct Register {
    Register(const char* name, std::function<void()> fn) { registry().emplace_back(name, fn); }
};

#define TEST(name)                                  \
    static void name();                             \
    static Register reg_##name(#name, name);        \
    static void name()

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::printf("  %s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
            ++failures;                                                          \
        }                                                                        \
    } while (0)

#define CHECK_EQ(a, b)                                                                  \
    do {                                                                                \
        auto va = (a);                                                                  \
        auto vb = (b);                                                                  \
        if (!(va == vb)) {                                                              \
            std::printf("  %s:%d: CHECK_EQ failed: %s == %s\n", __FILE__, __LINE__, #a, #b); \
            ++failures;                                                                 \
        }                                                                               \
    } while (0)

#define CHECK_THROWS(type, expr)                                                         \
    do {                                                                                 \
        bool caught = false;                                                             \
        try {                                                                            \
            (void)(expr);                                                                \
        } catch (const type&) {                                                          \
            caught = true;                                                               \
        } catch (...) {                                                                  \
        }                                                                                \
        if (!caught) {                                                                   \
            std::printf("  %s:%d: expected %s from %s\n", __FILE__, __LINE__, #type, #expr); \
            ++failures;                                                                  \
        }                                                                                \
    } while (0)

TEST(parse_simple) {
    CHECK_EQ(parse_amount("12.34"), 1234LL);
    CHECK_EQ(parse_amount("7"), 700LL);
    CHECK_EQ(parse_amount("0.5"), 50LL);
    CHECK_EQ(parse_amount("-3.25"), -325LL);
}

TEST(parse_rejects_garbage) {
    CHECK_THROWS(std::invalid_argument, parse_amount(""));
    CHECK_THROWS(std::invalid_argument, parse_amount("abc"));
    CHECK_THROWS(std::invalid_argument, parse_amount("1.2.3"));
}

TEST(format_simple) {
    CHECK_EQ(format_amount(1234), std::string("12.34"));
    CHECK_EQ(format_amount(5), std::string("0.05"));
    CHECK_EQ(format_amount(0), std::string("0.00"));
}

TEST(format_thousands) {
    CHECK_EQ(format_amount(123456789), std::string("1,234,567.89"));
    CHECK_EQ(format_amount(100000), std::string("1,000.00"));
}

TEST(deposit_and_withdraw) {
    Ledger l;
    l.open("alice");
    l.deposit("alice", 10000);
    l.withdraw("alice", 2550);
    CHECK_EQ(l.balance("alice"), 7450LL);
    CHECK_THROWS(InsufficientFunds, l.withdraw("alice", 7451));
    CHECK_EQ(l.balance("alice"), 7450LL);
}

TEST(unknown_account) {
    Ledger l;
    CHECK_THROWS(std::out_of_range, l.balance("nobody"));
    CHECK_THROWS(std::out_of_range, l.deposit("nobody", 100));
}

TEST(simple_transfer) {
    Ledger l;
    l.open("alice");
    l.open("bob");
    l.deposit("alice", 5000);
    l.transfer("alice", "bob", 1250);
    CHECK_EQ(l.balance("alice"), 3750LL);
    CHECK_EQ(l.balance("bob"), 1250LL);
}

TEST(simple_interest) {
    Ledger l;
    l.open("alice");
    l.deposit("alice", 100000);
    l.apply_interest("alice", 250);
    CHECK_EQ(l.balance("alice"), 102500LL);
}

TEST(even_split) {
    Ledger l;
    l.open("alice");
    l.open("bob");
    l.open("carol");
    l.deposit("alice", 9000);
    l.split("alice", {"bob", "carol"}, 3000);
    CHECK_EQ(l.balance("alice"), 6000LL);
    CHECK_EQ(l.balance("bob"), 1500LL);
    CHECK_EQ(l.balance("carol"), 1500LL);
}

// ---------------------------------------------------------------- amounts

TEST(parse_grouped) {
    CHECK_EQ(parse_amount("1,234"), 123400LL);
    CHECK_EQ(parse_amount("1,234,567.89"), 123456789LL);
    CHECK_EQ(parse_amount("12,345"), 1234500LL);
    CHECK_EQ(parse_amount("123,456.7"), 12345670LL);
    CHECK_EQ(parse_amount("-9,999.99"), -999999LL);
    CHECK_EQ(parse_amount("1234567"), 123456700LL);
    CHECK_EQ(parse_amount("0"), 0LL);
    CHECK_EQ(parse_amount("0.00"), 0LL);
    CHECK_EQ(parse_amount("007.10"), 710LL);
}

TEST(parse_rejects_bad_forms) {
    const char* bad[] = {"",      " 1",    "1 ",     "1 000", "+1",    "1e3",    ".5",     "5.",
                         "1,00",  "12,3456", ",123", "1,,000", "--1",  "-",      "1,234,56", "1234,567",
                         "1.2.3", "1,234.", "$5",    "5$",     "1_000", "0x10",  "-.5",    "1.-5",
                         "1,000,", "1.5,0", "\t1",   "1\n"};
    for (const char* s : bad) {
        bool caught = false;
        try {
            parse_amount(s);
        } catch (const std::invalid_argument&) {
            caught = true;
        } catch (...) {
        }
        if (!caught) {
            std::printf("  parse_amount(\"%s\") should throw std::invalid_argument\n", s);
            ++failures;
        }
    }
}

TEST(parse_rounds_half_even) {
    CHECK_EQ(parse_amount("1.005"), 100LL);
    CHECK_EQ(parse_amount("1.015"), 102LL);
    CHECK_EQ(parse_amount("1.0051"), 101LL);
    CHECK_EQ(parse_amount("1.00500000"), 100LL);
    CHECK_EQ(parse_amount("1.004999"), 100LL);
    CHECK_EQ(parse_amount("2.675"), 268LL);
    CHECK_EQ(parse_amount("0.125"), 12LL);
    CHECK_EQ(parse_amount("0.135"), 14LL);
    CHECK_EQ(parse_amount("0.999"), 100LL);
    CHECK_EQ(parse_amount("9.995"), 1000LL);
    CHECK_EQ(parse_amount("1,999.995"), 200000LL);
    CHECK_EQ(parse_amount("0.0050000001"), 1LL);
    CHECK_EQ(parse_amount("0.006"), 1LL);
}

TEST(parse_negative_rounding_is_symmetric) {
    CHECK_EQ(parse_amount("-1.005"), -100LL);
    CHECK_EQ(parse_amount("-1.015"), -102LL);
    CHECK_EQ(parse_amount("-2.675"), -268LL);
    CHECK_EQ(parse_amount("-0.004"), 0LL);
    CHECK_EQ(parse_amount("-0.005"), 0LL);
    CHECK_EQ(parse_amount("-0.0051"), -1LL);
}

TEST(format_negative_and_groups) {
    CHECK_EQ(format_amount(-123456), std::string("(1,234.56)"));
    CHECK_EQ(format_amount(-5), std::string("(0.05)"));
    CHECK_EQ(format_amount(-100), std::string("(1.00)"));
    CHECK_EQ(format_amount(99999), std::string("999.99"));
    CHECK_EQ(format_amount(10000000), std::string("100,000.00"));
    CHECK_EQ(format_amount(-100000000000LL), std::string("(1,000,000,000.00)"));
    CHECK_EQ(format_amount(1), std::string("0.01"));
    CHECK_EQ(format_amount(10), std::string("0.10"));
    CHECK_EQ(format_amount(123456789012345LL), std::string("1,234,567,890,123.45"));
}

TEST(format_parse_roundtrip) {
    long long values[] = {0, 1, -1, 99, 100, 123456, -123456, 100000000, 98765432101LL};
    for (long long v : values) {
        std::string s = format_amount(v);
        if (v < 0) s = "-" + s.substr(1, s.size() - 2);
        CHECK_EQ(parse_amount(s), v);
    }
}

// ---------------------------------------------------------------- accounts

TEST(account_ids) {
    Ledger l;
    l.open("a");
    l.open("Alice_01-x");
    l.open("alice_01-x");
    l.open(std::string(32, 'z'));
    l.deposit("Alice_01-x", 100);
    CHECK_EQ(l.balance("Alice_01-x"), 100LL);
    CHECK_EQ(l.balance("alice_01-x"), 0LL);
    CHECK_THROWS(std::out_of_range, l.balance("ALICE_01-X"));
    CHECK_THROWS(std::invalid_argument, l.open(""));
    CHECK_THROWS(std::invalid_argument, l.open(std::string(33, 'z')));
    CHECK_THROWS(std::invalid_argument, l.open("bob smith"));
    CHECK_THROWS(std::invalid_argument, l.open("bob.smith"));
    CHECK_THROWS(std::invalid_argument, l.open("caf\xc3\xa9"));
    CHECK_THROWS(std::invalid_argument, l.open("tab\t"));
}

TEST(open_duplicate_keeps_account) {
    Ledger l;
    l.open("alice", 500);
    l.deposit("alice", 1000);
    CHECK_THROWS(std::invalid_argument, l.open("alice"));
    CHECK_THROWS(std::invalid_argument, l.open("alice", 9999));
    CHECK_EQ(l.balance("alice"), 1000LL);
    CHECK_EQ(l.history("alice").size(), static_cast<std::size_t>(1));
    l.withdraw("alice", 1500);  // overdraft limit still 500
    CHECK_EQ(l.balance("alice"), -500LL);
    CHECK_THROWS(InsufficientFunds, l.withdraw("alice", 1));
}

TEST(open_negative_overdraft) {
    Ledger l;
    CHECK_THROWS(std::invalid_argument, l.open("alice", -1));
    CHECK_THROWS(std::out_of_range, l.balance("alice"));
}

TEST(unknown_accounts_everywhere) {
    Ledger l;
    l.open("alice");
    l.deposit("alice", 1000);
    CHECK_THROWS(std::out_of_range, l.withdraw("nobody", 100));
    CHECK_THROWS(std::out_of_range, l.transfer("alice", "nobody", 100));
    CHECK_THROWS(std::out_of_range, l.transfer("nobody", "alice", 100));
    CHECK_THROWS(std::out_of_range, l.split("alice", {"nobody"}, 100));
    CHECK_THROWS(std::out_of_range, l.split("nobody", {"alice"}, 100));
    CHECK_THROWS(std::out_of_range, l.apply_interest("nobody", 100));
    CHECK_THROWS(std::out_of_range, l.history("nobody"));
    CHECK_THROWS(std::out_of_range, l.statement("nobody"));
    CHECK_EQ(l.balance("alice"), 1000LL);
    CHECK_EQ(l.history("alice").size(), static_cast<std::size_t>(1));
}

TEST(non_positive_amounts) {
    Ledger l;
    l.open("alice", 10000);
    l.open("bob");
    CHECK_THROWS(std::invalid_argument, l.deposit("alice", 0));
    CHECK_THROWS(std::invalid_argument, l.deposit("alice", -5));
    CHECK_THROWS(std::invalid_argument, l.withdraw("alice", 0));
    CHECK_THROWS(std::invalid_argument, l.withdraw("alice", -5));
    CHECK_THROWS(std::invalid_argument, l.transfer("alice", "bob", 0));
    CHECK_THROWS(std::invalid_argument, l.transfer("alice", "bob", -5));
    CHECK_THROWS(std::invalid_argument, l.split("alice", {"bob"}, 0));
    CHECK_THROWS(std::invalid_argument, l.split("alice", {"bob"}, -3));
    CHECK_EQ(l.balance("alice"), 0LL);
    CHECK_EQ(l.balance("bob"), 0LL);
    CHECK(l.history("alice").empty());
    CHECK(l.history("bob").empty());
    l.deposit("alice", 1);
    CHECK_EQ(l.history("alice")[0].seq, 1LL);
}

TEST(self_transfer) {
    Ledger l;
    l.open("alice");
    l.deposit("alice", 1000);
    CHECK_THROWS(std::invalid_argument, l.transfer("alice", "alice", 100));
    CHECK_EQ(l.balance("alice"), 1000LL);
    CHECK_EQ(l.history("alice").size(), static_cast<std::size_t>(1));
}

// ---------------------------------------------------------------- overdraft & atomicity

TEST(overdraft_limit) {
    Ledger l;
    l.open("alice", 5000);
    l.open("bob");
    l.deposit("alice", 1000);
    l.withdraw("alice", 3000);
    CHECK_EQ(l.balance("alice"), -2000LL);
    CHECK_THROWS(InsufficientFunds, l.transfer("alice", "bob", 3001));
    l.transfer("alice", "bob", 3000);
    CHECK_EQ(l.balance("alice"), -5000LL);
    CHECK_EQ(l.balance("bob"), 3000LL);
    CHECK_THROWS(InsufficientFunds, l.withdraw("alice", 1));
    CHECK_THROWS(InsufficientFunds, l.withdraw("bob", 3001));
    l.withdraw("bob", 3000);
    CHECK_EQ(l.balance("bob"), 0LL);
}

TEST(insufficient_funds_is_runtime_error) {
    Ledger l;
    l.open("alice");
    CHECK_THROWS(std::runtime_error, l.withdraw("alice", 1));
}

TEST(failed_transfer_changes_nothing) {
    Ledger l;
    l.open("alice");
    l.open("bob");
    l.deposit("alice", 1000);
    l.deposit("bob", 50);
    CHECK_THROWS(InsufficientFunds, l.transfer("alice", "bob", 1001));
    CHECK_THROWS(std::out_of_range, l.transfer("alice", "carol", 10));
    CHECK_EQ(l.balance("alice"), 1000LL);
    CHECK_EQ(l.balance("bob"), 50LL);
    CHECK_EQ(l.history("alice").size(), static_cast<std::size_t>(1));
    CHECK_EQ(l.history("bob").size(), static_cast<std::size_t>(1));
    l.transfer("alice", "bob", 10);
    CHECK_EQ(l.history("alice").back().seq, 3LL);
    CHECK_EQ(l.history("bob").back().seq, 3LL);
}

// ---------------------------------------------------------------- history & sequence

TEST(history_entries) {
    Ledger l;
    l.open("alice", 1000);
    l.open("bob");
    l.deposit("alice", 5000);
    l.withdraw("alice", 1200);
    l.transfer("alice", "bob", 4300);
    l.deposit("bob", 1);
    auto h = l.history("alice");
    CHECK_EQ(h.size(), static_cast<std::size_t>(3));
    CHECK_EQ(h[0].seq, 1LL);
    CHECK(h[0].kind == Kind::Deposit);
    CHECK_EQ(h[0].amount, 5000LL);
    CHECK_EQ(h[0].balance_after, 5000LL);
    CHECK_EQ(h[0].counterparty, std::string(""));
    CHECK_EQ(h[1].seq, 2LL);
    CHECK(h[1].kind == Kind::Withdrawal);
    CHECK_EQ(h[1].amount, -1200LL);
    CHECK_EQ(h[1].balance_after, 3800LL);
    CHECK_EQ(h[2].seq, 3LL);
    CHECK(h[2].kind == Kind::TransferOut);
    CHECK_EQ(h[2].amount, -4300LL);
    CHECK_EQ(h[2].balance_after, -500LL);
    CHECK_EQ(h[2].counterparty, std::string("bob"));
    auto b = l.history("bob");
    CHECK_EQ(b.size(), static_cast<std::size_t>(2));
    CHECK_EQ(b[0].seq, 3LL);
    CHECK(b[0].kind == Kind::TransferIn);
    CHECK_EQ(b[0].amount, 4300LL);
    CHECK_EQ(b[0].balance_after, 4300LL);
    CHECK_EQ(b[0].counterparty, std::string("alice"));
    CHECK_EQ(b[1].seq, 4LL);
}

TEST(open_does_not_use_sequence) {
    Ledger l;
    l.open("alice");
    l.deposit("alice", 1);
    l.open("bob");
    l.deposit("bob", 1);
    CHECK_EQ(l.history("alice")[0].seq, 1LL);
    CHECK_EQ(l.history("bob")[0].seq, 2LL);
}

// ---------------------------------------------------------------- interest

TEST(interest_rounding) {
    struct Case {
        long long balance;
        int bps;
        long long interest;
    };
    Case cases[] = {
        {12345, 100, 123},   // 123.45 -> 123
        {12350, 100, 124},   // 123.50 -> 124 (tie, 123 odd -> 124)
        {12250, 100, 122},   // 122.50 -> 122 (tie, even)
        {12251, 100, 123},   // 122.51 -> 123
        {1, 5000, 0},        // 0.5 -> 0 (tie, even): nothing recorded
        {3, 5000, 2},        // 1.5 -> 2
        {5, 5000, 2},        // 2.5 -> 2
        {100000, 1, 10},
        {1000000000000LL, 1000000, 100000000000000LL},
        {999999999999LL, 999999, 99999899999900LL},  // 99999899999900.0001
        {33333, 3, 10},      // 9.9999 -> 10
    };
    for (const Case& c : cases) {
        Ledger l;
        l.open("a");
        l.deposit("a", c.balance);
        l.apply_interest("a", c.bps);
        if (l.balance("a") != c.balance + c.interest) {
            std::printf("  interest on %lld at %d bps: got %lld, want %lld\n", c.balance, c.bps,
                        l.balance("a") - c.balance, c.interest);
            ++failures;
        }
        std::size_t want_entries = c.interest == 0 ? 1 : 2;
        CHECK_EQ(l.history("a").size(), want_entries);
    }
}

TEST(interest_entry) {
    Ledger l;
    l.open("a");
    l.deposit("a", 74950);
    l.apply_interest("a", 250);  // 1873.75 -> 1874
    auto h = l.history("a");
    CHECK_EQ(h.size(), static_cast<std::size_t>(2));
    CHECK(h[1].kind == Kind::Interest);
    CHECK_EQ(h[1].amount, 1874LL);
    CHECK_EQ(h[1].balance_after, 76824LL);
    CHECK_EQ(h[1].seq, 2LL);
    CHECK_EQ(h[1].counterparty, std::string(""));
}

TEST(interest_skips_non_positive_balances) {
    Ledger l;
    l.open("a", 10000);
    l.open("b");
    l.apply_interest("a", 500);
    CHECK(l.history("a").empty());
    l.withdraw("a", 5000);
    l.apply_interest("a", 500);
    CHECK_EQ(l.balance("a"), -5000LL);
    CHECK_EQ(l.history("a").size(), static_cast<std::size_t>(1));
    l.deposit("b", 100);
    l.apply_interest("b", 0);
    CHECK_EQ(l.balance("b"), 100LL);
    CHECK_EQ(l.history("b").size(), static_cast<std::size_t>(1));
    l.deposit("b", 1);
    CHECK_EQ(l.history("b").back().seq, 3LL);  // skipped interest used no numbers
}

TEST(interest_negative_rate) {
    Ledger l;
    l.open("a");
    l.deposit("a", 1000);
    CHECK_THROWS(std::invalid_argument, l.apply_interest("a", -1));
    CHECK_EQ(l.balance("a"), 1000LL);
    CHECK_EQ(l.history("a").size(), static_cast<std::size_t>(1));
}

// ---------------------------------------------------------------- split

TEST(split_remainder_goes_to_first) {
    Ledger l;
    l.open("p");
    l.open("x");
    l.open("y");
    l.open("z");
    l.deposit("p", 10000);
    l.split("p", {"z", "x", "y"}, 1000);  // 333 r 1
    CHECK_EQ(l.balance("z"), 334LL);
    CHECK_EQ(l.balance("x"), 333LL);
    CHECK_EQ(l.balance("y"), 333LL);
    CHECK_EQ(l.balance("p"), 9000LL);
    l.split("p", {"y", "x", "z"}, 1001);  // 333 r 2
    CHECK_EQ(l.balance("y"), 333LL + 334LL);
    CHECK_EQ(l.balance("x"), 333LL + 334LL);
    CHECK_EQ(l.balance("z"), 334LL + 333LL);
    CHECK_EQ(l.balance("p"), 7999LL);
}

TEST(split_history) {
    Ledger l;
    l.open("p");
    l.open("a");
    l.open("b");
    l.deposit("p", 500);
    l.split("p", {"b", "a"}, 301);
    auto h = l.history("p");
    CHECK_EQ(h.size(), static_cast<std::size_t>(3));
    CHECK(h[1].kind == Kind::TransferOut);
    CHECK_EQ(h[1].counterparty, std::string("b"));
    CHECK_EQ(h[1].amount, -151LL);
    CHECK_EQ(h[1].balance_after, 349LL);
    CHECK_EQ(h[1].seq, 2LL);
    CHECK(h[2].kind == Kind::TransferOut);
    CHECK_EQ(h[2].counterparty, std::string("a"));
    CHECK_EQ(h[2].amount, -150LL);
    CHECK_EQ(h[2].balance_after, 199LL);
    CHECK_EQ(h[2].seq, 2LL);
    auto b = l.history("b");
    CHECK_EQ(b.size(), static_cast<std::size_t>(1));
    CHECK(b[0].kind == Kind::TransferIn);
    CHECK_EQ(b[0].amount, 151LL);
    CHECK_EQ(b[0].counterparty, std::string("p"));
    CHECK_EQ(b[0].seq, 2LL);
    l.deposit("a", 1);
    CHECK_EQ(l.history("a").back().seq, 3LL);
}

TEST(split_zero_shares) {
    Ledger l;
    l.open("p");
    l.open("a");
    l.open("b");
    l.open("c");
    l.deposit("p", 100);
    l.split("p", {"a", "b", "c"}, 2);
    CHECK_EQ(l.balance("a"), 1LL);
    CHECK_EQ(l.balance("b"), 1LL);
    CHECK_EQ(l.balance("c"), 0LL);
    CHECK(l.history("c").empty());
    CHECK_EQ(l.history("p").size(), static_cast<std::size_t>(3));
}

TEST(split_validation) {
    Ledger l;
    l.open("p", 100);
    l.open("a");
    l.open("b");
    l.deposit("p", 1000);
    CHECK_THROWS(std::invalid_argument, l.split("p", {}, 100));
    CHECK_THROWS(std::invalid_argument, l.split("p", {"a", "a"}, 100));
    CHECK_THROWS(std::invalid_argument, l.split("p", {"a", "b", "a"}, 100));
    CHECK_THROWS(std::invalid_argument, l.split("p", {"a", "p"}, 100));
    CHECK_THROWS(InsufficientFunds, l.split("p", {"a", "b"}, 1101));
    CHECK_THROWS(std::out_of_range, l.split("p", {"a", "zed"}, 100));
    CHECK_EQ(l.balance("p"), 1000LL);
    CHECK_EQ(l.balance("a"), 0LL);
    CHECK_EQ(l.balance("b"), 0LL);
    CHECK(l.history("a").empty());
    CHECK_EQ(l.history("p").size(), static_cast<std::size_t>(1));
    l.split("p", {"a", "b"}, 1100);  // down to exactly -100
    CHECK_EQ(l.balance("p"), -100LL);
    CHECK_EQ(l.history("a")[0].seq, 2LL);
}

// ---------------------------------------------------------------- statement

TEST(statement_example) {
    Ledger l;
    l.open("alice");
    l.open("bob");
    l.deposit("alice", 100000);
    l.transfer("alice", "bob", 25050);
    CHECK_EQ(l.statement("alice"), std::string("Statement for alice\n"
                                               "#1 deposit 1,000.00 -> 1,000.00\n"
                                               "#2 transfer to bob (250.50) -> 749.50\n"
                                               "Balance 749.50\n"));
    CHECK_EQ(l.statement("bob"), std::string("Statement for bob\n"
                                             "#2 transfer from alice 250.50 -> 250.50\n"
                                             "Balance 250.50\n"));
}

TEST(statement_all_kinds) {
    Ledger l;
    l.open("acc", 200000);
    l.open("x");
    l.open("y");
    l.deposit("acc", 1000);
    l.apply_interest("acc", 1234);  // 123.4 -> 123
    l.withdraw("acc", 150000);
    l.split("acc", {"y", "x"}, 3);
    l.deposit("x", 99);
    CHECK_EQ(l.statement("acc"), std::string("Statement for acc\n"
                                             "#1 deposit 10.00 -> 10.00\n"
                                             "#2 interest 1.23 -> 11.23\n"
                                             "#3 withdrawal (1,500.00) -> (1,488.77)\n"
                                             "#4 transfer to y (0.02) -> (1,488.79)\n"
                                             "#4 transfer to x (0.01) -> (1,488.80)\n"
                                             "Balance (1,488.80)\n"));
    CHECK_EQ(l.statement("x"), std::string("Statement for x\n"
                                           "#4 transfer from acc 0.01 -> 0.01\n"
                                           "#5 deposit 0.99 -> 1.00\n"
                                           "Balance 1.00\n"));
}

TEST(statement_empty) {
    Ledger l;
    l.open("new-acct");
    CHECK_EQ(l.statement("new-acct"), std::string("Statement for new-acct\nBalance 0.00\n"));
}

int main() {
    for (auto& [name, fn] : registry()) {
        int before = failures;
        try {
            fn();
        } catch (const std::exception& e) {
            std::printf("  unexpected exception: %s\n", e.what());
            ++failures;
        }
        std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", name);
    }
    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all tests passed\n");
    return 0;
}
