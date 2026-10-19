/**
 * Shared harness for the scripts in bench/scenarios/.
 *
 * Every scenario is a standalone script that hyperfine starts as a fresh
 * process. This module parses the common arguments, loads the library build
 * under test, and enforces the correctness guard: a scenario exits non-zero
 * when its output doesn't match the expected counts, when the library logs a
 * validation warning, or when `--buffer-budget` is set and `Buffer` memory
 * exceeds it. hyperfine stops on a non-zero exit, so a broken pipeline can't
 * report as a speedup.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setDeferredSinks } from './sinks.mjs';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const MB = 1024 * 1024;

/**
 * Resolve the library entry point and CLI from a package directory, so
 * `bench/compare.mjs` can point a scenario at another build with `--lib`.
 */
function resolvePackage(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const root = pkg.exports?.['.'];
  const entry =
    (typeof root === 'string' ? root : (root?.default ?? root?.import)) ??
    pkg.module ??
    pkg.main;
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.sitemap;
  return { entry: resolve(dir, entry), cli: resolve(dir, bin) };
}

/**
 * Run a scenario body and apply the correctness guard.
 *
 * @param {object} spec
 * @param {string} spec.name - Scenario name, as in bench/scenarios/<name>.mjs
 * @param {number} [spec.defaultSize] - Item count when --size is omitted
 * @param {number} [spec.sizeMultipleOf] - Required divisor of --size, for
 *   scenarios that repeat a fixed corpus
 * @param {boolean} [spec.levels=true] - Whether --level applies. Entry points
 *   with no error-level option (the CLI, simpleSitemapAndIndex) set false.
 * @param {boolean} [spec.corpusWarnings=false] - Tolerate validation warnings.
 *   Only for the realistic perf-data corpus, which has video titles over the
 *   100-character limit. The logger discards them, so they cost the error
 *   construction but no console I/O.
 * @param {(ctx: object) => Promise<void>} body - Runs the pipeline once and
 *   records results with ctx.expect()
 */
export async function scenario(spec, body) {
  const { values } = parseArgs({
    options: {
      size: { type: 'string' },
      level: { type: 'string', default: 'warn' },
      lib: { type: 'string', default: REPO_ROOT },
      'buffer-budget': { type: 'string' },
    },
  });

  try {
    const size = Number(values.size ?? spec.defaultSize ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`--size must be a non-negative integer`);
    }
    if (spec.sizeMultipleOf && size % spec.sizeMultipleOf !== 0) {
      throw new Error(
        `--size must be a multiple of ${spec.sizeMultipleOf} for ${spec.name}`
      );
    }
    if (!['silent', 'warn'].includes(values.level)) {
      throw new Error(`--level must be silent or warn`);
    }
    if (spec.levels === false && values.level !== 'warn') {
      throw new Error(`${spec.name} has no error level option; omit --level`);
    }

    const { entry, cli } = resolvePackage(resolve(values.lib));
    const lib = await import(pathToFileURL(entry).href);

    // Count, and discard, anything the library logs. Synthetic input is
    // meant to pass validation, so a warning means the input or the library
    // changed and the measurement now includes error handling.
    let warnings = 0;
    let firstWarning;
    const logger = (_level, ...message) => {
      warnings++;
      firstWarning ??= message.join(' ');
    };

    const budget = values['buffer-budget'];
    const sampler = budget === undefined ? undefined : bufferSampler();
    setDeferredSinks(sampler !== undefined);

    const failures = [];
    const expect = (label, actual, expected) => {
      const ok =
        typeof expected === 'function' ? expected(actual) : actual === expected;
      if (!ok) {
        failures.push(
          `${label}: got ${actual}` +
            (typeof expected === 'function' ? '' : `, expected ${expected}`)
        );
      }
    };

    await body({ size, level: values.level, lib, cli, logger, expect });

    if (warnings > 0 && !spec.corpusWarnings) {
      failures.push(
        `library logged ${warnings} warning(s); first: ${firstWarning}`
      );
    }
    if (sampler) {
      const peak = sampler.stop();
      const limit = Number(budget) * MB;
      console.error(
        `${spec.name}: peak external memory ${(peak / MB).toFixed(1)} MB (budget ${budget} MB)`
      );
      if (peak > limit) {
        failures.push(
          `peak external memory ${(peak / MB).toFixed(1)} MB exceeds the ${budget} MB budget`
        );
      }
    }
    if (failures.length) {
      throw new Error(
        `${spec.name} failed its correctness guard:\n  ${failures.join('\n  ')}`
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  }
}

/**
 * Sample memory outside the V8 heap while the scenario runs. `external`
 * already includes `arrayBuffers`, which covers every Node.js `Buffer`, so a
 * stream that ignores backpressure and queues serialized output shows up
 * here even though the heap cap doesn't catch it.
 */
function bufferSampler() {
  let peak = 0;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().external);
  };
  const timer = setInterval(sample, 5);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return peak;
    },
  };
}

export const MOCKS_DIR = join(REPO_ROOT, 'tests', 'mocks');
export const CACHE_DIR = join(REPO_ROOT, 'bench', '.cache');
