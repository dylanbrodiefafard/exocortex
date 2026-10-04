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
