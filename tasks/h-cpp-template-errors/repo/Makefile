CXX ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Werror -g

test_stats: test_stats.cpp $(wildcard *.hpp)
	$(CXX) $(CXXFLAGS) -o $@ test_stats.cpp

.PHONY: test clean
test: test_stats
	./test_stats

clean:
	rm -f test_stats
