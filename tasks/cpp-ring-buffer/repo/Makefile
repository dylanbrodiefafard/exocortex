CXXFLAGS ?= -std=c++17 -Wall -Wextra -Werror -g -fsanitize=address,undefined

test_ring_buffer: test_ring_buffer.cpp ring_buffer.hpp
	$(CXX) $(CXXFLAGS) -o $@ test_ring_buffer.cpp

.PHONY: test clean
test: test_ring_buffer
	./test_ring_buffer

clean:
	rm -f test_ring_buffer
