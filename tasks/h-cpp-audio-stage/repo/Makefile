CXX ?= g++
CXXFLAGS ?= -std=c++17 -O1 -g -Wall -Wextra -Werror
CPPFLAGS += -Isrc

LIB_SRC := $(sort $(shell find src -name '*.cpp' ! -path 'src/app/main.cpp'))
LIB_OBJ := $(LIB_SRC:%.cpp=build/%.o)
TEST_SRC := $(sort $(wildcard tests/*.cpp))
TEST_OBJ := $(TEST_SRC:%.cpp=build/%.o)

.PHONY: all test clean
all: build/tapeline

build/tapeline: $(LIB_OBJ) build/src/app/main.o
	$(CXX) $(CXXFLAGS) -o $@ $^

build/run_tests: $(LIB_OBJ) $(TEST_OBJ)
	$(CXX) $(CXXFLAGS) -o $@ $^

test: build/run_tests
	./build/run_tests

build/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -MMD -MP -c $< -o $@

clean:
	rm -rf build

-include $(LIB_OBJ:.o=.d) $(TEST_OBJ:.o=.d) build/src/app/main.d
