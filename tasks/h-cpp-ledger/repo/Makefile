CXX ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Werror -O1 -g

# Every .cpp here is part of the library, except the test and any file with a main() of its own.
PROGRAMS := $(shell grep -lE '^[[:space:]]*int[[:space:]]+main[^[:alnum:]_]' *.cpp 2>/dev/null)
FOUND := $(filter-out test_ledger.cpp $(PROGRAMS),$(sort $(wildcard *.cpp)))
ORDER := money.cpp ledger.cpp
SRCS := $(filter $(FOUND),$(ORDER)) $(filter-out $(ORDER),$(FOUND))

test_ledger: test_ledger.cpp $(SRCS) $(wildcard *.hpp)
	$(CXX) $(CXXFLAGS) -o $@ test_ledger.cpp $(SRCS)

.PHONY: test clean
test: test_ledger
	./test_ledger

clean:
	rm -f test_ledger
