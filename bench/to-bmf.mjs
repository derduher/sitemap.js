#!/usr/bin/env node
/**
 * Convert hyperfine JSON exports into one Bencher Metric Format (BMF) file
 * and print a summary of the plan's metrics.
 *
 * Usage: node bench/to-bmf.mjs [--results bench/results] [--out <file>]
 *
 * Each `<scenario>.json` in the results directory becomes one benchmark per
 * parameter combination, named like `generate-urls/size=1000000/level=warn`,
 * with these measures:
 *
 * - `latency`: wall-clock time per run, in nanoseconds
 * - `cpu-time`: user + system CPU time per run, in nanoseconds
 * - `peak-rss`: peak resident memory per run, in bytes (absent on Windows)
 * - `throughput`: items per second, after subtracting the median startup
 *   time (scenarios with a size only)
 *
 * `value` is the median and `lower_value`/`upper_value` are the first and
 * third quartiles. Latency, CPU time, and peak RSS are raw, so they stay
 * comparable with the `startup` benchmark; the summary subtracts startup.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { PARAMS } from './lib/hyperfine.mjs';
import { REPO_ROOT } from './lib/scenario.mjs';
import { median, quantile, summarize } from './lib/stats.mjs';

export const DEFAULT_RESULTS = join(REPO_ROOT, 'bench', 'results');
const NS = 1e9;
const MB = 1024 * 1024;

function unitValue(field, unit, label) {
  if (!field) {
    return undefined;
  }
  if (field.unit !== unit) {
    throw new Error(`${label}: expected unit ${unit}, got ${field.unit}`);
  }
  return field.value;
}

/**
 * Read one hyperfine export into benchmarks with per-run samples.
 *
 * @param {string} file
 * @param {string} [scenario] - Defaults to the file's base name
 */
export function readExport(file, scenario = basename(file, '.json')) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json.schema_version !== 2) {
    throw new Error(
      `${file}: hyperfine JSON schema_version is ${json.schema_version ?? 'missing'}, expected 2. Re-run with hyperfine 2.0.0 or later.`
    );
  }
  return json.results.map((result) => {
    // Schema 2 wraps each parameter as { value }.
    const params = Object.fromEntries(
      Object.entries(result.parameters ?? {}).map(([k, v]) => [
        k,
        typeof v === 'object' ? v.value : v,
      ])
    );
    const name = [
      scenario,
      ...PARAMS.filter((p) => p in params).map((p) => `${p}=${params[p]}`),
    ].join('/');
    const wall = [];
    const cpu = [];
    const rss = [];
    for (const m of result.measurements) {
      wall.push(unitValue(m.time_wall_clock, 'second', name));
      cpu.push(
        unitValue(m.time_user, 'second', name) +
          unitValue(m.time_system, 'second', name)
      );
      const peak = unitValue(m.memory_peak_resident, 'byte', name);
      if (peak !== undefined) {
        rss.push(peak);
      }
    }
    return {
      name,
      scenario,
      params,
      size: params.size === undefined ? undefined : Number(params.size),
      wall,
      cpu,
      rss,
    };
  });
}

const range = (values, scale = 1) => {
  const s = summarize(values);
  return {
    value: s.median * scale,
    lower_value: s.q1 * scale,
    upper_value: s.q3 * scale,
  };
};

/**
 * Convert hyperfine exports to BMF and derived metrics.
 *
 * @param {string[]} files - hyperfine JSON exports, including startup.json
 */
export function convert(files) {
  const benchmarks = files.flatMap(readExport);
  const startup = benchmarks.find((b) => b.name === 'startup');
  if (!startup) {
    throw new Error(
      'No startup.json among the results; it is the baseline for throughput and memory.'
    );
  }
  const base = {
    wall: median(startup.wall),
    cpu: median(startup.cpu),
    rss: startup.rss.length ? median(startup.rss) : undefined,
  };

  const bmf = {};
  for (const b of benchmarks) {
    const entry = {
      latency: range(b.wall, NS),
      'cpu-time': range(b.cpu, NS),
    };
    if (b.rss.length) {
      entry['peak-rss'] = range(b.rss);
    }
    if (b.size) {
      // Higher wall time means lower throughput, so the quartiles swap.
      const work = (t) => b.size / (t - base.wall);
      entry.throughput = {
        value: work(median(b.wall)),
        lower_value: work(quantile(b.wall, 0.75)),
        upper_value: work(quantile(b.wall, 0.25)),
      };
      b.throughput = b.wall.map(work);
      b.cpuPerItem = b.cpu.map((t) => ((t - base.cpu) / b.size) * 1e6);
    }
    if (b.rss.length && base.rss !== undefined) {
      b.rssAboveBase = b.rss.map((r) => (r - base.rss) / MB);
    }
    bmf[b.name] = entry;
  }
  return { bmf, benchmarks };
}

const fmt = (n, digits = 2) =>
  n === undefined || Number.isNaN(n)
    ? '—'
    : Math.abs(n) >= 1000
      ? Math.round(n).toLocaleString('en-US')
      : n.toFixed(digits);

function table(title, benchmarks, pick, digits) {
  const rows = benchmarks.filter((b) => pick(b)?.length);
  if (!rows.length) {
    return '';
  }
  const lines = [
    `### ${title}`,
    '',
    '| Benchmark | Median | IQR | Min | n |',
    '|---|--:|--:|--:|--:|',
  ];
  for (const b of rows) {
    const s = summarize(pick(b));
    lines.push(
      `| ${b.name} | ${fmt(s.median, digits)} | ${fmt(s.iqr, digits)} | ${fmt(s.min, digits)} | ${s.n} |`
    );
  }
  return lines.join('\n') + '\n';
}

/** Render the summary as Markdown. */
export function summary(benchmarks) {
  const out = [
    table('Throughput (items/s)', benchmarks, (b) => b.throughput, 0),
    table('Wall-clock time (s)', benchmarks, (b) => b.wall, 3),
    table(
      'CPU time per item, user + system, minus startup (µs)',
      benchmarks,
      (b) => b.cpuPerItem,
      3
    ),
    table(
      'Peak RSS above the startup baseline (MB)',
      benchmarks,
      (b) => b.rssAboveBase,
      1
    ),
  ];

  // Memory growth: (peak at 1M - peak at 100k) / 9, per 100k items.
  const growth = [];
  for (const big of benchmarks.filter((b) => b.size === 1_000_000)) {
    const small = benchmarks.find(
      (b) =>
        b.scenario === big.scenario &&
        b.size === 100_000 &&
        b.params.level === big.params.level
    );
    if (small?.rss.length && big.rss.length) {
      const perStep = (median(big.rss) - median(small.rss)) / 9 / MB;
      growth.push(
        `| ${big.name.replace('size=1000000', 'size=100k→1M')} | ${fmt(perStep, 1)} |`
      );
    }
  }
  if (growth.length) {
    out.push(
      [
        '### Memory growth (MB of peak RSS per additional 100k items)',
        '',
        '| Benchmark | MB per 100k |',
        '|---|--:|',
        ...growth,
        '',
      ].join('\n')
    );
  }

  // Validation overhead: WARN throughput / SILENT throughput.
  const overhead = [];
  for (const warn of benchmarks.filter(
    (b) => b.params.level === 'warn' && b.throughput
  )) {
    const silent = benchmarks.find(
      (b) =>
        b.scenario === warn.scenario &&
        b.size === warn.size &&
        b.params.level === 'silent'
    );
    if (silent?.throughput) {
      const ratio = median(warn.throughput) / median(silent.throughput);
      overhead.push(
        `| ${warn.name.replace('level=warn', 'level=warn÷silent')} | ${fmt(ratio, 3)} |`
      );
    }
  }
  if (overhead.length) {
    out.push(
      [
        '### Validation overhead (WARN ÷ SILENT throughput)',
        '',
        '| Benchmark | Ratio |',
        '|---|--:|',
        ...overhead,
        '',
      ].join('\n')
    );
  }
  return out.filter(Boolean).join('\n');
}

/** List the hyperfine exports in a results directory. */
export function resultFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'bmf.json' && f !== 'meta.json')
    .map((f) => join(dir, f));
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      results: { type: 'string', default: DEFAULT_RESULTS },
      out: { type: 'string' },
    },
  });
  try {
    const { bmf, benchmarks } = convert(resultFiles(values.results));
    const out = values.out ?? join(values.results, 'bmf.json');
    writeFileSync(out, JSON.stringify(bmf, null, 2) + '\n');
    console.log(summary(benchmarks));
    console.log(`Wrote ${out}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
