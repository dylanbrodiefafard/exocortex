# Pipeline files

A pipeline file lists settings, then stages:

```
# voice cleanup
block_size = 512

[dcblock]

[gate]
threshold_db = -45
hold_ms = 120

[gain]
db = 3
```

- `#` starts a comment, anywhere on a line.
- Lines before the first `[stage]` header are settings. The only setting is
  `block_size` (int, default 256, 1 to 65536): the largest number of frames
  a stage processes at once.
- Each `[name]` header adds a stage (see `docs/stages.md`); the same stage
  may appear more than once. The lines under it set its parameters as
  `key = value`. Parameters left out keep their defaults.

## Errors

Every problem is reported with its line number, and `tapeline` prefixes the
file name:

```
line 3: unknown stage 'reverb'
line 4: stage 'gain': unknown parameter 'dB'
line 4: stage 'gain': parameter 'db' must be a number, got 'loud'
line 4: stage 'gain': parameter 'db' must be between -60 and 24, got '30'
line 5: stage 'clip': parameter 'mode' must be one of hard, soft, got 'medium'
line 6: stage 'gain': parameter 'db' given twice
line 1: setting 'block_size' must be between 1 and 65536, got '0'
line 2: expected 'key = value' or '[stage]'
```

Numbers in messages are written without trailing zeros (`24`, `0.95`).
