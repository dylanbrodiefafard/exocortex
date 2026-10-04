#pragma once

// Minimal TAP-style test harness.

#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace check {

struct Case {
    std::string name;
    std::function<void()> body;
};

inline std::vector<Case>& registry() {
    static std::vector<Case> cases;
    return cases;
}

struct Registrar {
    Registrar(const char* name, std::function<void()> body) { registry().push_back({name, std::move(body)}); }
};

inline int& assertions() {
    static int n = 0;
    return n;
}

inline int& failures() {
    static int n = 0;
    return n;
}

template <typename A, typename B>
void expect_eq(const A& actual, const B& expected, const char* expr, const char* file, int line) {
    ++assertions();
    if (actual == expected) {
        std::cout << "    ok " << assertions() << " - " << expr << "\n";
        return;
    }
    ++failures();
    std::ostringstream msg;
    msg << "    not ok " << assertions() << " - " << expr << "\n"
        << "      at " << file << ":" << line << "\n"
        << "      actual:   " << actual << "\n"
        << "      expected: " << expected << "\n";
    std::cout << msg.str();
}

inline void expect_true(bool value, const char* expr, const char* file, int line) {
    expect_eq(value, true, expr, file, line);
}

template <typename E, typename F>
void expect_throws(F&& fn, const char* expr, const char* file, int line) {
    bool threw = false;
    try {
        fn();
    } catch (const E&) {
        threw = true;
    } catch (...) {
    }
    expect_eq(threw, true, expr, file, line);
}

inline int run_all() {
    int failed_cases = 0;
    int index = 0;
    std::cout << "1.." << registry().size() << "\n";
    for (const Case& c : registry()) {
        ++index;
        int before = failures();
        std::cout << "# " << c.name << "\n";
        try {
            c.body();
        } catch (const std::exception& e) {
            ++failures();
            std::cout << "    not ok - unexpected exception: " << e.what() << "\n";
        }
        bool passed = failures() == before;
        if (!passed) {
            ++failed_cases;
        }
        std::cout << (passed ? "ok " : "not ok ") << index << " - " << c.name << "\n";
    }
    std::cout << "# " << registry().size() - failed_cases << "/" << registry().size() << " cases passed, "
              << assertions() - failures() << "/" << assertions() << " assertions\n";
    return failed_cases == 0 ? 0 : 1;
}

}  // namespace check

#define CHECK_CAT2(a, b) a##b
#define CHECK_CAT(a, b) CHECK_CAT2(a, b)
#define TEST_CASE(name)                                                                     \
    static void CHECK_CAT(test_fn_, __LINE__)();                                            \
    static check::Registrar CHECK_CAT(test_reg_, __LINE__)(name, CHECK_CAT(test_fn_, __LINE__)); \
    static void CHECK_CAT(test_fn_, __LINE__)()
#define EXPECT_EQ(actual, expected) check::expect_eq((actual), (expected), #actual " == " #expected, __FILE__, __LINE__)
#define EXPECT_TRUE(expr) check::expect_true((expr), #expr, __FILE__, __LINE__)
#define EXPECT_THROWS(E, stmt) check::expect_throws<E>([&] { stmt; }, #stmt " throws " #E, __FILE__, __LINE__)
