#pragma once

// TAP output, one line per check. The CI dashboard parses every line, so keep it verbose.

#include <iostream>
#include <sstream>
#include <string>

namespace tap {

struct State {
    int total = 0;
    int failed = 0;
    std::string section;
};

inline State& state() {
    static State s;
    return s;
}

inline void section(const std::string& name) {
    state().section = name;
    std::cout << "# --- " << name << " ---\n";
}

template <typename A, typename B>
void eq(const A& actual, const B& expected, const std::string& what) {
    State& s = state();
    ++s.total;
    if (actual == expected) {
        std::cout << "ok " << s.total << " - " << s.section << ": " << what << "\n";
        return;
    }
    ++s.failed;
    std::ostringstream msg;
    msg << "not ok " << s.total << " - " << s.section << ": " << what << "\n"
        << "  #   got:      " << actual << "\n"
        << "  #   expected: " << expected << "\n";
    std::cout << msg.str();
}

inline void truth(bool value, const std::string& what) { eq(value, true, what); }

inline int finish() {
    const State& s = state();
    std::cout << "1.." << s.total << "\n";
    std::cout << "# " << (s.total - s.failed) << "/" << s.total << " checks passed\n";
    return s.failed == 0 ? 0 : 1;
}

}  // namespace tap
