CXX ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Werror -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all
CPPFLAGS += -Iinclude
LDFLAGS += -fsanitize=address,undefined

SRCS := $(wildcard src/*.cpp)
OBJS := $(patsubst src/%.cpp,build/%.o,$(SRCS))
HDRS := $(wildcard include/mkb/*.hpp)

build/%.o: src/%.cpp $(HDRS) | build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c -o $@ $<

build/test_graph.o: tests/test_graph.cpp $(HDRS) | build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c -o $@ $<

build/test_graph: build/test_graph.o $(OBJS)
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDFLAGS)

build:
	mkdir -p build

.PHONY: test clean
test: build/test_graph
	./build/test_graph

clean:
	rm -rf build
