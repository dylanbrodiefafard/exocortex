# netcalc

IPv4/IPv6 address library and CLI used by the firewall-rule generator.

- `Ipv4` / `Prefix4` (`include/netcalc/ipv4.hpp`): strict dotted-quad parsing, prefix
  arithmetic (network, broadcast, host ranges, containment) and range summarization.
- `Ipv6` (`include/netcalc/ipv6.hpp`): RFC 4291 parsing and RFC 5952 canonical formatting.
- `tools/netcalc.cpp`: command-line front end.

The header comments are the specification.

## Building and testing

```
make test
```

builds the library, the CLI and the test binary, then runs the tests. The test binary
prints one TAP line per check (several thousand); CI archives the whole log and the
dashboard parses every line, so the output format and verbosity are part of the contract.
