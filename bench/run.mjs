#!/usr/bin/env node
/**
 * Run every benchmark scenario under hyperfine and convert the results.
 *
 * Usage: npm run bench -- [--scenario a,b] [--runs 20] [--warmup 2]
 *
 * `npm run bench` builds first; this script measures whatever is in dist/.
 * It writes one hyperfine export per scenario, plus meta.json with the
 * environment and bmf.json for Bencher, to bench/results/. The `startup`
 * scenario always runs, so every result set has a baseline from the same
 * session.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkHyperfine,
  hyperfineArgs,
  runHyperfine,
  selectScenarios,
} from './lib/hyperfine.mjs';
import { REPO_ROOT } from './lib/scenario.mjs';
import { convert, DEFAULT_RESULTS, summary } from './to-bmf.mjs';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    runs: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '2' },
    results: { type: 'string', default: DEFAULT_RESULTS },
  },
});

function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

try {
  const hyperfineVersion = checkHyperfine();
  const scenarios = selectScenarios(values.scenario);
  mkdirSync(values.results, { recursive: true });

  writeFileSync(
    join(values.results, 'meta.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        commit: git('rev-parse', 'HEAD'),
        dirty: Boolean(git('status', '--porcelain')),
        node: process.version,
        hyperfine: hyperfineVersion,
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        memoryGB: Math.round(totalmem() / 1024 ** 3),
      },
      null,
      2
    ) + '\n'
  );

  const files = [];
  for (const name of scenarios) {
    console.log(`\n=== ${name} ===`);
    const exportJson = join(values.results, `${name}.json`);
    runHyperfine(
      hyperfineArgs(name, {
        commands: [{ lib: REPO_ROOT }],
        runs: Number(values.runs),
        warmup: Number(values.warmup),
        exportJson,
      })
    );
    files.push(exportJson);
  }

  const { bmf, benchmarks } = convert(files);
  const bmfFile = join(values.results, 'bmf.json');
  writeFileSync(bmfFile, JSON.stringify(bmf, null, 2) + '\n');
  console.log('\n' + summary(benchmarks));
  console.log(`Wrote ${bmfFile}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
