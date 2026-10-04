CXX ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Werror -O1 -g

SRCS = money.cpp ledger.cpp

test_ledger: test_ledger.cpp $(SRCS) $(wildcard *.hpp)
	$(CXX) $(CXXFLAGS) -o $@ test_ledger.cpp $(SRCS)

.PHONY: test clean
test: test_ledger
	./test_ledger

clean:
	rm -f test_ledger
