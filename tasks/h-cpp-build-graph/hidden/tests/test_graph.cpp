#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

#include "mkb/graph.hpp"
#include "mkb/manifest.hpp"
#include "mkb/registry.hpp"

static int failures = 0;

#define CHECK(cond)                                                                       \
    do {                                                                                  \
        if (!(cond)) {                                                                    \
            std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond "\n";    \
            ++failures;                                                                   \
        }                                                                                 \
    } while (0)

static std::string join(const std::vector<std::string>& v) {
    std::string out;
    for (const auto& s : v) out += (out.empty() ? "" : " ") + s;
    return out;
}

#define CHECK_LIST(got, want)                                                                         \
    do {                                                                                              \
        std::string g_ = join(got), w_ = (want);                                                      \
        if (g_ != w_) {                                                                               \
            std::cerr << __FILE__ << ":" << __LINE__ << ": got [" << g_ << "] want [" << w_ << "]\n"; \
            ++failures;                                                                               \
        }                                                                                             \
    } while (0)

// The error message from parsing `text`, or "" if it parsed.
static std::string parse_error(const std::string& text) {
    try {
        mkb::parse_manifest(text);
    } catch (const mkb::GraphError& e) {
        return e.what();
    }
    return "";
}

#define CHECK_ERROR(text, want)                                                                           \
    do {                                                                                                  \
        std::string e_ = parse_error(text);                                                               \
        if (e_ != (want)) {                                                                               \
            std::cerr << __FILE__ << ":" << __LINE__ << ": error was \"" << e_ << "\", want \"" << (want) \
                      << "\"\n";                                                                          \
            ++failures;                                                                                   \
        }                                                                                                 \
    } while (0)

MKB_REGISTER_KIND(mkb::RuleKind{
    "proto_library",
    {"srcs"},
    {"srcs"},
    [](const mkb::Target& t) { return std::vector<std::string>{"proto/" + t.name() + ".pb.h"}; },
});

static const char* kWorkspace = R"(# demo workspace
cc_binary //app:main srcs=main.cc deps=//lib:util,//lib:log,//gen:version
cc_library //lib:util srcs=util.cc,str.cc hdrs=util.h deps=//lib:log
cc_library //lib:log srcs=log.cc
genrule //gen:version outs=version.h tool=stamp.sh deps=//tools:stamp

filegroup //tools:stamp srcs=stamp.sh
cc_test //lib:util_test srcs=util_test.cc deps=//lib:util size=small
proto_library //api:msgs srcs=msgs.proto
)";

static void test_kinds_from_every_translation_unit() {
    CHECK(mkb::find_kind("sh_binary") != nullptr);
    CHECK(mkb::find_kind("genrule") != nullptr);
    CHECK(mkb::find_kind("proto_library") != nullptr);
    CHECK(mkb::find_kind("java_library") == nullptr);
}

static void test_parse_and_order() {
    mkb::Graph g = mkb::parse_manifest(kWorkspace);
    CHECK(g.size() == 7);
    const mkb::Target* main = g.find("//app:main");
    CHECK(main != nullptr);
    if (main) {
        CHECK_LIST(main->deps, "//lib:util //lib:log //gen:version");
        CHECK(main->line == 2);
        CHECK(main->kind == "cc_binary");
    }
    const mkb::Target* util = g.find("//lib:util");
    CHECK(util && util->attrs.at("srcs") == (std::vector<std::string>{"util.cc", "str.cc"}));
    CHECK_LIST(g.build_order(),
               "//lib:log //lib:util //tools:stamp //gen:version //app:main //lib:util_test //api:msgs");
}

static void test_transitive_outputs() {
    mkb::Graph g = mkb::parse_manifest(kWorkspace);
    CHECK_LIST(g.transitive_outputs("//app:main"), "app/main lib/liblog.a lib/libutil.a tools/stamp.sh gen/version.h");
    CHECK_LIST(g.transitive_outputs("//gen:version"), "gen/version.h tools/stamp.sh");
    CHECK_LIST(g.transitive_outputs("//api:msgs"), "proto/msgs.pb.h");
}

static void test_errors() {
    CHECK_ERROR("rust_library //a:b srcs=x.rs\n", "line 1: unknown rule kind 'rust_library' for //a:b");
    CHECK_ERROR("cc_library //a:b srcs=a.cc deps=//c:d\n", "line 1: //a:b depends on undeclared target //c:d");
    CHECK_ERROR("\ncc_library //a:b hdrs=a.h\n", "line 2: //a:b (cc_library) is missing required attribute 'srcs'");
    CHECK_ERROR("cc_library //a:b srcs=a.cc\ncc_test //a:b srcs=t.cc\n", "line 2: //a:b is already declared on line 1");
    CHECK_ERROR("cc_library //a:b srcs=a.cc outs=x\n", "line 1: cc_library does not accept attribute 'outs'");
    CHECK_ERROR("cc_library //A:b srcs=a.cc\n", "line 1: malformed label '//A:b'");
}

static void test_cycle() {
    mkb::Graph g = mkb::parse_manifest(
        "cc_library //a:a srcs=a.cc deps=//b:b\n"
        "cc_library //b:b srcs=b.cc deps=//c:c\n"
        "cc_library //c:c srcs=c.cc deps=//a:a\n");
    std::string err;
    try {
        g.build_order();
    } catch (const mkb::GraphError& e) {
        err = e.what();
    }
    CHECK(err == "dependency cycle: //a:a -> //b:b -> //c:c -> //a:a");
}

MKB_REGISTER_KIND(mkb::RuleKind{
    "sh_binary",
    {"srcs"},
    {"srcs"},
    [](const mkb::Target& t) { return std::vector<std::string>{"bin/" + t.name()}; },
});

static void test_large_manifest_with_forward_references() {
    const int n = 3000;
    std::string text;
    for (int i = 0; i < n; ++i) {
        text += "cc_library //pkg:t" + std::to_string(i) + " srcs=t.cc";
        if (i + 2 < n) text += " deps=//pkg:t" + std::to_string(i + 1) + ",//pkg:t" + std::to_string(i + 2);
        text += "\n";
    }
    text += "sh_binary //tools:run srcs=run.sh deps=//pkg:t0,//pkg:t1500\n";
    mkb::Graph g = mkb::parse_manifest(text);
    CHECK(g.size() == static_cast<std::size_t>(n) + 1);
    for (int i : {0, 1, 1234, n - 3}) {
        const mkb::Target* t = g.find("//pkg:t" + std::to_string(i));
        CHECK(t && t->line == i + 1 && t->kind == "cc_library");
        CHECK(t && t->deps == (std::vector<std::string>{"//pkg:t" + std::to_string(i + 1),
                                                        "//pkg:t" + std::to_string(i + 2)}));
        CHECK(t && t->attrs.at("srcs") == std::vector<std::string>{"t.cc"});
    }
    const mkb::Target* run = g.find("//tools:run");
    CHECK(run && run->kind == "sh_binary" && run->deps.size() == 2);
    std::vector<std::string> order = g.build_order();
    CHECK(order.size() == static_cast<std::size_t>(n) + 1);
    if (order.size() == static_cast<std::size_t>(n) + 1) {
        CHECK(order[0] == "//pkg:t" + std::to_string(n - 2));
        CHECK(order[1] == "//pkg:t" + std::to_string(n - 1));
        CHECK(order[n - 1] == "//pkg:t0");
        CHECK(order.back() == "//tools:run");
    }
    std::vector<std::string> outs = g.transitive_outputs("//tools:run");
    CHECK(outs.size() == static_cast<std::size_t>(n) + 1 && outs.front() == "bin/run");
}

static void test_many_deps_on_one_line() {
    std::string text = "filegroup //all:all srcs=x";
    text += " deps=";
    for (int i = 0; i < 100; ++i) text += (i ? ",//d:f" : "//d:f") + std::to_string(i);
    text += "\n";
    for (int i = 99; i >= 0; --i) text += "filegroup //d:f" + std::to_string(i) + " srcs=f" + std::to_string(i) + "\n";
    mkb::Graph g = mkb::parse_manifest(text);
    const mkb::Target* all = g.find("//all:all");
    CHECK(all && all->deps.size() == 100 && all->deps[57] == "//d:f57");
    CHECK(all && all->attrs.at("srcs") == std::vector<std::string>{"x"});
    std::vector<std::string> order = g.build_order();
    CHECK(!order.empty() && order.front() == "//d:f99" && order.back() == "//all:all");
}

static void test_registered_kinds_are_shared() {
    CHECK_LIST(mkb::kind_names(), "cc_binary cc_library cc_test filegroup genrule proto_library sh_binary");
    mkb::Graph g = mkb::parse_manifest("genrule //g:x outs=x.h tool=t deps=//s:y\nsh_binary //s:y srcs=y.sh\n");
    CHECK_LIST(g.transitive_outputs("//g:x"), "g/x.h bin/y");
}

int main() {
    test_large_manifest_with_forward_references();
    test_many_deps_on_one_line();
    test_registered_kinds_are_shared();
    test_kinds_from_every_translation_unit();
    test_parse_and_order();
    test_transitive_outputs();
    test_errors();
    test_cycle();
    if (failures) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all tests passed\n";
    return 0;
}
