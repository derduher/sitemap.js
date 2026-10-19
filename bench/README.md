# Benchmarks

This directory holds the performance benchmarks for sitemap.js. For the
metrics and the reasoning behind this setup, see
[Performance measurement plan](../docs/performance/measurement-plan.md).

## Before you begin

- Install [hyperfine](https://github.com/sharkdp/hyperfine) 2.0.0 or later,
  for example with `brew install hyperfine` or a release binary. The scripts
  check the version and stop with instructions if it's older.
- Plug a laptop into power and close other heavy applications.
- Don't compare results from different machines.

## Compare your change with a base branch

To check whether a change makes the library slower or use more memory, run
the comparison against the branch you started from:

```bash
npm run bench:compare -- master
```

The script builds `master` in a temporary git worktree and your working tree
in place, then runs every scenario under hyperfine with both builds. It
alternates which build goes first across 4 rounds of 5 runs each and prints
a Markdown table you can paste into your pull request description. It also
writes the table to `bench/results/compare/compare.md`.

A full comparison takes about an hour, most of it `parse-xml` reading 1 GB of
XML. To compare only the scenarios your change affects, pass
`--scenario`:

```bash
npm run bench:compare -- master --scenario generate-urls,split-and-index
```

Each row reports the median for both builds, the relative change, and a 95%
bootstrap confidence interval. The verdict is **regression** only when the
whole interval is above the threshold, 5% by default (`--threshold`), and
the script then exits with code 1.

### Measure the noise floor

Before you trust a comparison on a new machine, compare a clean build with
itself:

```bash
npm run bench:compare -- HEAD
```

The widest confidence interval in that A/A run is the machine's noise floor.
Set `--threshold` above it. Repeat the A/A run when the machine or the
scenarios change.

## Run the full benchmark suite

```bash
npm run bench
```

The command builds the package, runs each scenario under hyperfine, and
writes the results to `bench/results/`, which git ignores:

- `<scenario>.json`: hyperfine's export, with every run's wall-clock time,
  CPU time, and peak memory.
- `bmf.json`: the results in Bencher Metric Format, for CI.
- `meta.json`: the commit, Node.js version, operating system, and CPU.

It then prints throughput, wall-clock time, CPU time per item, peak memory
above the startup baseline, memory growth with input size, and validation
overhead, each with the median, interquartile range (IQR), minimum, and
sample count.

To run some scenarios only, or fewer runs while you iterate, pass options
after `--`:

```bash
npm run bench -- --scenario parse-index --runs 5 --warmup 1
```

To convert existing results again without rerunning them, run
`node bench/to-bmf.mjs`.

## Check that streaming uses bounded memory

```bash
npm run test:memory
```

This runs `generate-urls`, `split-and-index`, and `parse-xml` at 1M items
under a 64 MB V8 heap cap and a 32 MB `Buffer` budget, and fails if a
pipeline buffers its input or output instead of streaming it. CI runs it as
the `memory` job.

## Scenarios

Each scenario is a standalone script in `scenarios/` that runs one pipeline
once in a fresh process. Scenario names are stable identifiers: Bencher keys
history by them, so don't rename one without a reason.

| Scenario | Entry point | Input |
|---|---|---|
| `startup` | Package import only | None |
| `cli-startup` | `sitemap` CLI | One URL on stdin |
| `generate-urls` | `SitemapStream` | Seeded URLs |
| `generate-rich` | `SitemapStream` | Seeded items with images, video, news, and `hreflang` links |
| `generate-from-lines` | `lineSeparatedURLsToSitemapOptions` → `SitemapStream` | `tests/mocks/perf-data.json.txt`, repeated |
| `split-and-index` | `SitemapAndIndexStream` | Seeded URLs, written to a temporary directory |
| `simple-gzip` | `simpleSitemapAndIndex` | Seeded URLs, gzipped to a temporary directory |
| `parse-xml` | `XMLToSitemapItemStream` | `tests/mocks/perf-data.xml`, repeated with unique URLs by a child process |
| `parse-index` | `XMLToSitemapIndexStream` | A cached 50,000-entry index, repeated |
| `round-trip` | `XMLToSitemapItemStream` → `SitemapStream` | `tests/mocks/perf-data.xml`, repeated |
| `cli` | `sitemap` CLI | Seeded URLs on stdin |

You can run a scenario on its own:

```bash
node bench/scenarios/generate-urls.mjs --size 100000 --level silent
```

Every scenario takes these options:

- `--size`: the item count. Scenarios that repeat a fixed corpus need a
  multiple of its size.
- `--level`: `silent` or `warn` (default), for entry points with an error
  level.
- `--lib`: the package directory to load, which defaults to this checkout.
  `bench:compare` uses it to point at the base build.
- `--buffer-budget`: fail if `Buffer` memory exceeds this many megabytes.
  `test:memory` sets it.

Each scenario checks its own output before it exits: the item count, and
for synthetic input, that the library logged no validation warnings. It
exits with a non-zero code on a mismatch, so hyperfine stops instead of
reporting a broken pipeline as a speedup. The realistic corpus has some
video titles over the 100-character limit, so the scenarios that read it
tolerate those warnings; their logger discards them, so they cost no
console output.

To add a scenario, add a script to `scenarios/` that calls `scenario()` from
`lib/scenario.mjs`, and add its sizes and levels to `SCENARIOS` in
`lib/hyperfine.mjs`.

## Continuous benchmarking

CI records results with [Bencher](https://bencher.dev):

- `.github/workflows/bench-master.yml` runs on every push to `master` and
  builds the history that comparisons use.
- `.github/workflows/bench-pr.yml` runs on pull requests from this
  repository that have the `performance` label, and posts a check and a
  comment.
- `.github/workflows/bench-fork-pr-run.yml` and `bench-fork-pr-track.yml`
  do the same for pull requests from forks, in two steps so the fork's code
  never runs with the Bencher API key.
