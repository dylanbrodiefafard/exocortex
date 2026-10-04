"""Parsing of human-written durations."""


def parse_duration(text):
    """Parse a duration such as "1h30m", "45s" or "2d 4h" into whole seconds.

    Rules:
    - A duration is one or more <integer><unit> parts, optionally separated by whitespace.
    - Units are d (days), h (hours), m (minutes) and s (seconds), case-insensitive.
    - Each unit may appear at most once, and units must appear in the order d, h, m, s.
    - Leading/trailing whitespace is ignored.
    - Anything else (empty input, unknown units, missing numbers, repeated or out-of-order
      units, signs, decimals) raises ValueError.
    """
    raise NotImplementedError
