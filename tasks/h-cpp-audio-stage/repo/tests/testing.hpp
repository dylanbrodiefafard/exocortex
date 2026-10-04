#pragma once

// A minimal test framework: TEST(name) { ... } registers a test; the CHECK
// macros record failures without stopping the test.

#include <cmath>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace testing {

struct TestCase {
    const char* name;
    std::function<void()> fn;
};

inline std::vector<TestCase>& registry() {
    static std::vector<TestCase> tests;
    return tests;
}

inline int& failures() {
    static int count = 0;
    return count;
}

struct Registrar {
    Registrar(const char* name, std::function<void()> fn) { registry().push_back({name, std::move(fn)}); }
};

inline void fail(const char* file, int line, const std::string& message) {
    ++failures();
    std::cerr << file << ":" << line << ": " << message << "\n";
}

template <typename T>
std::string show(const T& v) {
    std::ostringstream ss;
    ss << v;
    return ss.str();
}

}  // namespace testing

#define TEST(name)                                                   \
    static void name();                                              \
    static const ::testing::Registrar name##_registrar(#name, name); \
    static void name()

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) ::testing::fail(__FILE__, __LINE__, "CHECK(" #cond ")"); \
    } while (0)

#define CHECK_EQ(a, b)                                                                                \
    do {                                                                                              \
        const auto check_a_ = (a);                                                                    \
        const auto check_b_ = (b);                                                                    \
        if (!(check_a_ == check_b_)) {                                                                \
            ::testing::fail(__FILE__, __LINE__,                                                       \
                            "CHECK_EQ(" #a ", " #b "): " + ::testing::show(check_a_) + " != " +       \
                                ::testing::show(check_b_));                                           \
        }                                                                                             \
    } while (0)

#define CHECK_NEAR(a, b, eps)                                                                          \
    do {                                                                                               \
        const double check_a_ = (a);                                                                   \
        const double check_b_ = (b);                                                                   \
        if (!(std::fabs(check_a_ - check_b_) <= (eps))) {                                              \
            ::testing::fail(__FILE__, __LINE__,                                                        \
                            "CHECK_NEAR(" #a ", " #b "): " + ::testing::show(check_a_) + " vs " +      \
                                ::testing::show(check_b_));                                            \
        }                                                                                              \
    } while (0)

// Checks that `expr` throws `type` with what() equal to `message`.
#define CHECK_THROWS(expr, type, message)                                                          \
    do {                                                                                           \
        try {                                                                                      \
            (void)(expr);                                                                          \
            ::testing::fail(__FILE__, __LINE__, "expected " #type " from " #expr);                 \
        } catch (const type& check_e_) {                                                           \
            if (std::string(check_e_.what()) != (message)) {                                       \
                ::testing::fail(__FILE__, __LINE__,                                                \
                                std::string("wrong message: \"") + check_e_.what() + "\" != \"" +  \
                                    (message) + "\"");                                             \
            }                                                                                      \
        }                                                                                          \
    } while (0)
