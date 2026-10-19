#!/usr/bin/env node
/**
 * Compare the working tree's performance with another git ref.
 *
 * Usage: npm run bench:compare -- <base-ref> [--scenario a,b] [--rounds 4]
 *   [--runs 5] [--warmup 1] [--threshold 5]
 *
 * Builds <base-ref> in a temporary git worktree and the working tree in
 * place, then runs each scenario under hyperfine with the build as a
 * parameter. hyperfine runs every run of one build before the other, so
 * this runs `--rounds` rounds of `--runs` runs per side, swapping which
 * build goes first each round, and merges the measurements. That way
 * thermal throttling or background load in one block doesn't land on one
 * side only.
 *
 * Both sides run the working tree's bench/ scripts and the same `node`
 * binary; only the library build differs. The output is a Markdown table
 * with medians, the relative change, and a 95% bootstrap confidence
 * interval per benchmark and measure. A change counts as a regression or an
 * improvement only when the whole interval is beyond `--threshold` percent.
 * Set the threshold above the noise floor from an A/A run
 * (`npm run bench:compare -- HEAD` on a clean tree).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkHyperfine,
  hyperfineArgs,
  runHyperfine,
  selectScenarios,
} from './lib/hyperfine.mjs';
import { REPO_ROOT } from './lib/scenario.mjs';
import { median, relativeDifference } from './lib/stats.mjs';
import { DEFAULT_RESULTS, readExport } from './to-bmf.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string' },
    rounds: { type: 'string', default: '4' },
    runs: { type: 'string', default: '5' },
    warmup: { type: 'string', default: '1' },
    threshold: { type: 'string', default: '5' },
    results: { type: 'string', default: join(DEFAULT_RESULTS, 'compare') },
  },
});

const MEASURES = [
  {
    key: 'wall',
    label: 'wall time',
    format: (v) => `${(v * 1000).toFixed(1)} ms`,
  },
  {
    key: 'cpu',
    label: 'CPU time',
    format: (v) => `${(v * 1000).toFixed(1)} ms`,
  },
  {
    key: 'rss',
    label: 'peak RSS',
    format: (v) => `${(v / 1024 / 1024).toFixed(1)} MB`,
  },
];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();

/** Install dependencies for, and build, the base worktree in `dir`. */
function buildBase(ref, dir) {
  const lockfile = (root) => {
    const path = join(root, 'package-lock.json');
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  if (lockfile(dir) === lockfile(REPO_ROOT)) {
    // Same dependencies: reuse this checkout's install.
    symlinkSync(
      join(REPO_ROOT, 'node_modules'),
      join(dir, 'node_modules'),
      'dir'
    );
  } else {
    console.log(`Dependencies differ at ${ref}; running npm ci in ${dir}`);
    run('npm', ['ci', '--ignore-scripts'], dir);
  }
  console.log(`Building ${ref} in ${dir}`);
  run('npm', ['run', 'build'], dir);
}

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function compareTable(samples, threshold) {
  const lines = [
    '| Benchmark | Measure | Base | Head | Change | 95% CI | Verdict |',
    '|---|---|--:|--:|--:|--:|---|',
  ];
  let regressions = 0;
  for (const [name, sides] of samples) {
    for (const { key, label, format } of MEASURES) {
      const base = sides.base[key];
      const head = sides.head[key];
      if (!base.length || !head.length) {
        continue;
      }
      const { diff, low, high } = relativeDifference(base, head);
      // For every measure here, higher is worse.
      let verdict = 'no change';
      if (low > threshold) {
        verdict = '**regression**';
        regressions++;
      } else if (high < -threshold) {
        verdict = 'improvement';
      }
      lines.push(
        `| ${name} | ${label} | ${format(median(base))} | ${format(median(head))} | ${pct(diff)} | ${pct(low)} to ${pct(high)} | ${verdict} |`
      );
    }
  }
  return { table: lines.join('\n'), regressions };
}

const [baseRef] = positionals;
if (!baseRef) {
  console.error(
    'Usage: npm run bench:compare -- <base-ref> [--scenario a,b] [--rounds 4] [--runs 5]'
  );
  process.exit(2);
}

let baseDir;
try {
  checkHyperfine();
  // Always includes startup, so every comparison reports it too.
  const scenarios = selectScenarios(values.scenario);
  const rounds = Number(values.rounds);
  const threshold = Number(values.threshold) / 100;

  const baseSha = run(
    'git',
    ['rev-parse', '--short', `${baseRef}^{commit}`],
    REPO_ROOT
  );
  const headSha = run('git', ['rev-parse', '--short', 'HEAD'], REPO_ROOT);
  const dirty =
    run('git', ['status', '--porcelain', '--untracked-files=no'], REPO_ROOT) !==
    '';

  console.log('Building the working tree');
  run('npm', ['run', 'build'], REPO_ROOT);
  const dir = mkdtempSync(join(tmpdir(), 'sitemap-bench-base-'));
  run('git', ['worktree', 'add', '--detach', dir, baseRef], REPO_ROOT);
  // Set before building, so the finally block removes the worktree even if
  // the build fails.
  baseDir = dir;
  buildBase(baseRef, baseDir);

  mkdirSync(values.results, { recursive: true });
  const builds = { base: baseDir, head: REPO_ROOT };

  // name -> { base: {wall, cpu, rss}, head: {wall, cpu, rss} }
  const samples = new Map();
  for (const scenario of scenarios) {
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
      console.log(
        `\n=== ${scenario}, round ${round + 1} of ${rounds} (${order.join(' first, ')} second) ===`
      );
      const exportJson = join(
        values.results,
        `${scenario}-round${round + 1}.json`
      );
      runHyperfine(
        hyperfineArgs(scenario, {
          libs: order.map((side) => builds[side]),
          runs: Number(values.runs),
          warmup: Number(values.warmup),
          exportJson,
          // Comparisons merge rounds of a fixed size, so ignore a
          // scenario's own run-count override.
          ignoreRunsOverride: true,
        })
      );
      for (const b of readExport(exportJson, scenario)) {
        const entry = samples.get(b.name) ?? {
          base: { wall: [], cpu: [], rss: [] },
          head: { wall: [], cpu: [], rss: [] },
        };
        const side = entry[b.params.lib === baseDir ? 'base' : 'head'];
        side.wall.push(...b.wall);
        side.cpu.push(...b.cpu);
        side.rss.push(...b.rss);
        samples.set(b.name, entry);
      }
    }
  }

  const { table, regressions } = compareTable(samples, threshold);
  const report = [
    `## Benchmark comparison: ${baseRef} (${baseSha}) → ${dirty ? `working tree on ${headSha}` : headSha}`,
    '',
    `Node.js ${process.version} on ${platform()}, ${cpus()[0]?.model ?? 'unknown CPU'}. ` +
      `${rounds} rounds × ${values.runs} runs per side, alternating order. ` +
      `Regression threshold: ${values.threshold}% (the whole 95% interval must exceed it).`,
    '',
    table,
    '',
  ].join('\n');
  writeFileSync(join(values.results, 'compare.md'), report);
  console.log('\n' + report);
  console.log(`Wrote ${join(values.results, 'compare.md')}`);
  process.exitCode = regressions ? 1 : 0;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  if (baseDir) {
    // Remove the node_modules symlink first, so nothing can follow it into
    // this checkout's install. A real install (after npm ci) goes with the
    // worktree.
    const modules = join(baseDir, 'node_modules');
    if (lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) {
      unlinkSync(modules);
    }
    run('git', ['worktree', 'remove', '--force', baseDir], REPO_ROOT);
  }
}
