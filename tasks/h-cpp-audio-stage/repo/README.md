# tapeline

A small audio processing pipeline: a text file lists processing stages
(gain, filters, gates, ...) which are applied in order to a WAV file.

```
make
./build/tapeline --list-stages
./build/tapeline --describe gate
./build/tapeline --check examples/voice.conf
./build/tapeline -c examples/voice.conf in.wav out.wav
```

- `docs/pipeline-files.md`: the pipeline file format and its error messages.
- `docs/stages.md`: every stage, its parameters, and the conventions stages
  follow.

## Layout

| Path | What |
|---|---|
| `src/audio/` | Audio buffers and WAV I/O |
| `src/dsp/` | Shared DSP helpers (time and level conversions) |
| `src/config/` | Pipeline file parsing and parameter schemas |
| `src/pipeline/` | The stage interface, the stage registry, the pipeline |
| `src/stages/` | The built-in stages, one per file |
| `src/app/` | Command line interface |
| `tests/` | Unit tests (`make test`) |

C++17, no dependencies beyond the standard library.
