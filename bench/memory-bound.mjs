#!/usr/bin/env node
/**
 * Bounded-memory check: assert that the streaming pipelines finish at 1M
 * items without holding their input or output in memory.
 *
 * Usage: npm run test:memory -- [--scenario a,b] [--size 1000000]
 *
 * Each scenario runs as its own process under a small V8 heap cap. A
 * pipeline that buffers JavaScript objects runs out of heap and crashes;
 * one that streams finishes. The heap cap doesn't cover `Buffer` memory, so
 * each scenario also samples `process.memoryUsage().external` and fails if
 * the peak exceeds a fixed budget. That catches broken backpressure, where
 * serialized output piles up in a stream's internal buffer.
 *
 * With --buffer-budget set, the scenarios' sinks acknowledge some writes on
 * a later event-loop turn, so they apply backpressure like a real file or
 * socket and a pipeline that ignores it piles up output.
 *
 * This asserts rather than measures, so it doesn't use hyperfine. It takes
 * about a minute, most of it parse-xml reading 1 GB of XML, so it runs as
 * its own CI job rather than in `npm test`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from './lib/scenario.mjs';

const SCENARIOS = ['generate-urls', 'split-and-index', 'parse-xml'];
// Streaming runs measure under 5 MB of external memory at 1M items and peak
// at about 10 MB of V8 heap. Both limits leave headroom for platform
// differences while staying well below what buffering 1M items needs.
const HEAP_MB = 64;
const BUFFER_BUDGET_MB = 32;

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    size: { type: 'string', default: '1000000' },
  },
});

const selected = values.scenario
  ? values.scenario.split(',').map((s) => s.trim())
  : SCENARIOS;
const unknown = selected.filter((s) => !SCENARIOS.includes(s));
if (unknown.length) {
  console.error(
    `Unknown scenario: ${unknown.join(', ')}. Known: ${SCENARIOS.join(', ')}`
  );
  process.exit(2);
}

let failed = 0;
for (const name of selected) {
  const start = performance.now();
  const result = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${HEAP_MB}`,
      join(REPO_ROOT, 'bench', 'scenarios', `${name}.mjs`),
      '--size',
      values.size,
      '--buffer-budget',
      String(BUFFER_BUDGET_MB),
    ],
    { stdio: 'inherit' }
  );
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`ok   ${name} (${seconds} s)`);
  } else {
    failed++;
    const why = result.signal
      ? `killed by ${result.signal}`
      : `exit code ${result.status}`;
    console.log(
      `FAIL ${name} (${seconds} s, ${why}): it ran out of its ${HEAP_MB} MB heap or exceeded the ${BUFFER_BUDGET_MB} MB Buffer budget, so it holds data in memory instead of streaming`
    );
  }
}
process.exit(failed ? 1 : 0);
