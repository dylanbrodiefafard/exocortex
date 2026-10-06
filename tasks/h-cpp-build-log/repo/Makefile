# Build log is kept verbose on purpose: CI greps the full compiler command lines.
MAKEFLAGS += --keep-going

CXX      ?= g++
STD      := -std=c++17
OPT      := -O1 -g
WARNINGS := -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wold-style-cast \
            -Wcast-qual -Wformat=2 -Wduplicated-cond -Wlogical-op -Wdouble-promotion -Wuseless-cast \
            -Wnon-virtual-dtor -Woverloaded-virtual -Wmissing-declarations
DEFINES  := -DLATENCY_VERSION='"1.4.2"' -DLATENCY_BUILD_KIND='"ci"' -D_GLIBCXX_ASSERTIONS
CPPFLAGS := -Iinclude -Itests $(DEFINES)
CXXFLAGS := $(STD) $(OPT) $(WARNINGS) -fno-omit-frame-pointer -fdiagnostics-color=never -MMD -MP
LDFLAGS  :=

BUILD    := build
# Every .cpp in src/ is part of the library. These build first, in this order; any other follows.
LIB_ORDER := src/strutil.cpp src/csv.cpp src/record.cpp src/stats.cpp src/histogram.cpp src/report.cpp
LIB_FOUND := $(sort $(wildcard src/*.cpp))
LIB_SRCS := $(filter $(LIB_FOUND),$(LIB_ORDER)) $(filter-out $(LIB_ORDER),$(LIB_FOUND))
LIB_OBJS := $(LIB_SRCS:%.cpp=$(BUILD)/%.o)
LIB      := $(BUILD)/liblatency.a
TEST_BIN := $(BUILD)/latency_tests
TOOL_BIN := $(BUILD)/latency_report
DEMO_BIN := $(BUILD)/histogram_demo

.PHONY: all test clean
all: $(LIB) $(TOOL_BIN) $(TEST_BIN) $(DEMO_BIN)

$(BUILD)/%.o: %.cpp
	@mkdir -p $(dir $@)
	@echo "[CXX] $(CXX) $(CXXFLAGS) $(CPPFLAGS) -c $< -o $@"
	@$(CXX) $(CXXFLAGS) $(CPPFLAGS) -c $< -o $@

$(LIB): $(LIB_OBJS)
	@echo "[AR]  ar rcs $@ $^"
	@ar rcs $@ $^

$(TEST_BIN): $(BUILD)/tests/tests.o $(LIB)
	@echo "[LD]  $(CXX) $(LDFLAGS) -o $@ $^"
	@$(CXX) $(LDFLAGS) -o $@ $^

$(TOOL_BIN): $(BUILD)/tools/latency_report.o $(LIB)
	@echo "[LD]  $(CXX) $(LDFLAGS) -o $@ $^"
	@$(CXX) $(LDFLAGS) -o $@ $^

$(DEMO_BIN): $(BUILD)/examples/histogram_demo.o $(LIB)
	@echo "[LD]  $(CXX) $(LDFLAGS) -o $@ $^"
	@$(CXX) $(LDFLAGS) -o $@ $^

test: all
	@echo "[RUN] $(TEST_BIN)"
	@$(TEST_BIN)

clean:
	rm -rf $(BUILD)

-include $(LIB_OBJS:.o=.d) $(BUILD)/tests/tests.d $(BUILD)/tools/latency_report.d $(BUILD)/examples/histogram_demo.d
