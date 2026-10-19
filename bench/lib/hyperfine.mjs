/**
 * The scenario matrix and the hyperfine invocations shared by bench/run.mjs
 * and bench/compare.mjs.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CORPUS_SIZE, INDEX_SIZE } from '../fixtures.mjs';
import { REPO_ROOT } from './scenario.mjs';

const BOTH = ['silent', 'warn'];

/**
 * Parameters for each scenario. Scenario names are stable identifiers:
 * Bencher keys history by them.
 *
 * - `sizes`: item counts, passed as `--size`. Two sizes, 100k and 1M,
 *   give the memory-growth metric.
 * - `levels`: error levels, passed as `--level`. Both levels give the
 *   validation-overhead metric. Scenarios without `levels` run at the
 *   default, `warn`, because their entry point has no level option or they
 *   aren't generation scenarios.
 * - `setup`: run `node bench/fixtures.mjs <name>` before the runs.
 * - `runs`: override the run count for a scenario too slow for the default.
 */
export const SCENARIOS = {
  startup: {},
  'cli-startup': {},
  'generate-urls': { sizes: [100_000, 1_000_000], levels: BOTH },
  'generate-rich': { sizes: [100_000], levels: BOTH },
  'generate-from-lines': { sizes: [CORPUS_SIZE * 10], levels: BOTH },
  'split-and-index': { sizes: [100_000, 1_000_000], levels: BOTH },
  'simple-gzip': { sizes: [1_000_000] },
  // About 37 s per run at 1M items (1 GB of XML), so fewer runs.
  'parse-xml': { sizes: [100_000, 1_000_000], runs: 10 },
  'parse-index': { sizes: [INDEX_SIZE * 4], setup: true },
  'round-trip': { sizes: [CORPUS_SIZE * 2], levels: BOTH },
  cli: { sizes: [1_000_000] },
};

/** Parameter names, in the order they appear in benchmark names. */
export const PARAMS = ['size', 'level'];

/** Resolve a comma-separated `--scenario` filter, always keeping `startup`. */
export function selectScenarios(filter) {
  if (!filter) {
    return Object.keys(SCENARIOS);
  }
  const names = filter.split(',').map((s) => s.trim());
  for (const name of names) {
    if (!(name in SCENARIOS)) {
      throw new Error(
        `Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`
      );
    }
  }
  return ['startup', ...names.filter((n) => n !== 'startup')];
}

/** Quote an argument for hyperfine's shell-words splitting under `-N`. */
const q = (arg) =>
  /^[\w./:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/**
 * Build hyperfine arguments for one scenario.
 *
 * @param {string} name - Scenario name
 * @param {object} opts
 * @param {string[]} opts.libs - Package directories of the library builds
 *   to run. With more than one (bench/compare.mjs), the build becomes a
 *   hyperfine parameter, `lib`, in the order given.
 * @param {number} opts.runs
 * @param {number} opts.warmup
 * @param {string} opts.exportJson
 * @param {boolean} [opts.ignoreRunsOverride] - Use `runs` even when the
 *   scenario sets its own run count
 */
export function hyperfineArgs(
  name,
  { libs, runs, warmup, exportJson, ignoreRunsOverride = false }
) {
  const config = SCENARIOS[name];
  const node = process.execPath;
  const script = join(REPO_ROOT, 'bench', 'scenarios', `${name}.mjs`);
  // -N: start each run directly, without a shell, so no shell startup
  // lands in the measurement.
  const args = [
    '-N',
    '--warmup',
    String(warmup),
    '--runs',
    String(ignoreRunsOverride ? runs : (config.runs ?? runs)),
  ];
  if (config.setup) {
    args.push(
      '--setup',
      [node, join(REPO_ROOT, 'bench', 'fixtures.mjs'), name].map(q).join(' ')
    );
  }
  let command = [node, script].map(q).join(' ');
  if (libs.length > 1) {
    if (libs.some((lib) => lib.includes(','))) {
      throw new Error(`Library paths can't contain commas: ${libs.join(' ')}`);
    }
    args.push('-L', 'lib', libs.join(','));
    command += ' --lib {lib}';
  } else {
    command += ` --lib ${q(libs[0])}`;
  }
  if (config.sizes) {
    args.push('-L', 'size', config.sizes.join(','));
    command += ' --size {size}';
  }
  if (config.levels) {
    args.push('-L', 'level', config.levels.join(','));
    command += ' --level {level}';
  }
  args.push('--export-json', exportJson, command);
  return args;
}

/** Run hyperfine, streaming its progress to the terminal. */
export function runHyperfine(args) {
  const result = spawnSync('hyperfine', args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`hyperfine exited with code ${result.status}`);
  }
}

/** Stop with instructions unless hyperfine 2.x or later is installed. */
export function checkHyperfine() {
  const result = spawnSync('hyperfine', ['--version'], { encoding: 'utf8' });
  const version = result.stdout?.match(/hyperfine (\d+)\.(\d+)\.(\d+)/);
  if (result.error || !version) {
    throw new Error(
      'hyperfine is not installed. Install hyperfine 2.0.0 or later, for example with `brew install hyperfine` or a release binary from https://github.com/sharkdp/hyperfine/releases.'
    );
  }
  if (Number(version[1]) < 2) {
    throw new Error(
      `Found hyperfine ${version.slice(1).join('.')}; the benchmarks need 2.0.0 or later, whose JSON export (schema_version 2) bench/to-bmf.mjs reads. Install a newer release from https://github.com/sharkdp/hyperfine/releases.`
    );
  }
  return version.slice(1).join('.');
}
