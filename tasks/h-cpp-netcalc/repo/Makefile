# The full command lines and every TAP line are archived by CI; keep the output verbose.
CXX      ?= g++
CXXFLAGS := -std=c++17 -O1 -g -Wall -Wextra -Wpedantic -Wshadow -Wconversion -fdiagnostics-color=never -MMD -MP
CPPFLAGS := -Iinclude -Itests

BUILD    := build
# Every .cpp in src/ is part of the library.
LIB_SRCS := $(sort $(wildcard src/*.cpp))
LIB_OBJS := $(LIB_SRCS:%.cpp=$(BUILD)/%.o)
LIB      := $(BUILD)/libnetcalc.a
TEST_BIN := $(BUILD)/netcalc_tests
TOOL_BIN := $(BUILD)/netcalc

.PHONY: all test clean
all: $(LIB) $(TEST_BIN) $(TOOL_BIN)

$(BUILD)/%.o: %.cpp
	@mkdir -p $(dir $@)
	@echo "[CXX] $(CXX) $(CXXFLAGS) $(CPPFLAGS) -c $< -o $@"
	@$(CXX) $(CXXFLAGS) $(CPPFLAGS) -c $< -o $@

$(LIB): $(LIB_OBJS)
	@echo "[AR]  ar rcs $@ $^"
	@ar rcs $@ $^

$(TEST_BIN): $(BUILD)/tests/test_netcalc.o $(LIB)
	@echo "[LD]  $(CXX) -o $@ $^"
	@$(CXX) -o $@ $^

$(TOOL_BIN): $(BUILD)/tools/netcalc.o $(LIB)
	@echo "[LD]  $(CXX) -o $@ $^"
	@$(CXX) -o $@ $^

test: all
	@echo "[RUN] $(TEST_BIN)"
	@$(TEST_BIN)

clean:
	rm -rf $(BUILD)

-include $(LIB_OBJS:.o=.d) $(BUILD)/tests/test_netcalc.d $(BUILD)/tools/netcalc.d
