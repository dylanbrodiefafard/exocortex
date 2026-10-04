#pragma once

#include <stdexcept>
#include <string>

namespace tapeline {

// A problem in a pipeline file. what() is "line <n>: <message>" (or just the
// message when no line applies).
class ConfigError : public std::runtime_error {
public:
    ConfigError(int line, const std::string& message)
        : std::runtime_error(line > 0 ? "line " + std::to_string(line) + ": " + message : message),
          line_(line),
          message_(message) {}

    int line() const { return line_; }
    const std::string& message() const { return message_; }

private:
    int line_;
    std::string message_;
};

}  // namespace tapeline
