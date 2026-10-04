#include "ring_buffer.hpp"

#include <cstdio>
#include <cstdlib>

static int failures = 0;

#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            std::fprintf(stderr, "%s:%d: CHECK(%s) failed\n", __FILE__, \
                         __LINE__, #cond);                              \
            ++failures;                                                 \
        }                                                               \
    } while (0)

static void fifo_order() {
    RingBuffer<int> rb(3);
    rb.push(1);
    rb.push(2);
    CHECK(rb.pop() == 1);
    CHECK(rb.pop() == 2);
    CHECK(!rb.pop().has_value());
}

static void wraps_around() {
    RingBuffer<int> rb(3);
    for (int round = 0; round < 5; ++round) {
        rb.push(round * 10 + 1);
        rb.push(round * 10 + 2);
        CHECK(rb.pop() == round * 10 + 1);
        CHECK(rb.pop() == round * 10 + 2);
    }
    CHECK(rb.empty());
}

static void overwrites_oldest_when_full() {
    RingBuffer<int> rb(3);
    for (int i = 1; i <= 5; ++i) rb.push(i);
    CHECK(rb.size() == 3);
    CHECK(rb.pop() == 3);
    CHECK(rb.pop() == 4);
    CHECK(rb.pop() == 5);
    CHECK(rb.empty());
}

static void overwrite_after_wrap() {
    RingBuffer<int> rb(2);
    rb.push(1);
    rb.push(2);
    CHECK(rb.pop() == 1);
    rb.push(3);
    rb.push(4);
    CHECK(rb.size() == 2);
    CHECK(rb.pop() == 3);
    CHECK(rb.pop() == 4);
}

int main() {
    fifo_order();
    wraps_around();
    overwrites_oldest_when_full();
    overwrite_after_wrap();
    if (failures != 0) {
        std::fprintf(stderr, "%d check(s) failed\n", failures);
        return EXIT_FAILURE;
    }
    std::puts("all ring buffer tests passed");
    return EXIT_SUCCESS;
}
