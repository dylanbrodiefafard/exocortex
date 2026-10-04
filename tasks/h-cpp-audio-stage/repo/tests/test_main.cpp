#include "testing.hpp"

int main() {
    int run = 0;
    for (const auto& t : testing::registry()) {
        int before = testing::failures();
        try {
            t.fn();
        } catch (const std::exception& e) {
            testing::fail(t.name, 0, std::string("uncaught exception: ") + e.what());
        }
        ++run;
        if (testing::failures() != before) std::cerr << "FAILED: " << t.name << "\n";
    }
    std::cout << run << " tests, " << testing::failures() << " failures\n";
    return testing::failures() == 0 ? 0 : 1;
}
