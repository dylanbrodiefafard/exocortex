#include <iostream>
#include <string>
#include <vector>

#include "app/cli.hpp"

int main(int argc, char** argv) {
    std::vector<std::string> args(argv + 1, argv + argc);
    return tapeline::run_cli(args, std::cout, std::cerr);
}
