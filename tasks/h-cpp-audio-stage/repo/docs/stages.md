# Stages

Each `[name]` section of a pipeline file adds one stage; stages run in file
order. `tapeline --list-stages` lists them and `tapeline --describe NAME`
shows a stage's parameters with their types, defaults and ranges.

Conventions every stage follows:

- **Parameters** are declared with their type, default and range; the
  pipeline file is validated against those declarations before anything
  runs (see `docs/pipeline-files.md` for the error messages). A stage never
  parses or range-checks values itself.
- **Time parameters** are given in milliseconds and converted to samples
  with `dsp::ms_to_samples`: rounded to the nearest sample, halves rounding
  up (2.5 ms at 1000 Hz is 3 samples).
- **Channels** are processed independently unless the stage says otherwise.
- **State** (filter memories, counters, delay lines) is kept per channel,
  carried across blocks so the output does not depend on `block_size`, and
  cleared by a reset.

## gain

Multiplies every sample by the linear factor for `db` decibels.

| Parameter | Type | Default | Range |
|---|---|---|---|
| `db` | float | 0 | -60 to 24 |

## clip

Limits samples to `threshold`. `mode = hard` cuts them off at ±threshold;
`mode = soft` applies `threshold * tanh(x / threshold)`.

| Parameter | Type | Default | Range |
|---|---|---|---|
| `threshold` | float | 1 | 0.01 to 1 |
| `mode` | choice | hard | hard, soft |

## fade

Fades the start of the stream in: with N = `in_ms` converted to samples,
frame n (counting from the start of the stream) is multiplied by n / N for
n < N.

| Parameter | Type | Default | Range |
|---|---|---|---|
| `in_ms` | float | 10 | 0 to 60000 |

## lowpass

One-pole low-pass filter: `y[n] = y[n-1] + a * (x[n] - y[n-1])` with
`a = 1 - exp(-2π * cutoff_hz / sample_rate)`. `cutoff_hz` must be below
half the sample rate.

| Parameter | Type | Default | Range |
|---|---|---|---|
| `cutoff_hz` | float | 1000 | 10 to 20000 |

## dcblock

Removes DC offset: `y[n] = x[n] - x[n-1] + r * y[n-1]`.

| Parameter | Type | Default | Range |
|---|---|---|---|
| `r` | float | 0.995 | 0.9 to 0.9999 |

## gate

Silences a channel once it has been quieter than `threshold_db` for more
than `hold_ms` (converted to samples): the first H quiet samples in a row
pass, later ones are muted until a sample reaches the threshold again.

| Parameter | Type | Default | Range |
|---|---|---|---|
| `threshold_db` | float | -50 | -100 to 0 |
| `hold_ms` | float | 50 | 0 to 5000 |

## pan

Constant-power panning of a stereo stream; `position` -1 is hard left, 1
hard right. The centre leaves both channels unchanged. Needs exactly 2
channels.

| Parameter | Type | Default | Range |
|---|---|---|---|
| `position` | float | 0 | -1 to 1 |
