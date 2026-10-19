// The `sitemap` CLI with generated URLs on stdin, output discarded. The CLI
// has no error-level option, so it always runs at the default level.
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { countingSink } from '../lib/sinks.mjs';
import { runChild } from '../lib/child.mjs';
import { urlLines } from '../fixtures.mjs';

await scenario(
  { name: 'cli', defaultSize: 1_000_000, levels: false },
  async ({ size, cli, expect }) => {
    const child = spawn(process.execPath, [cli], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const sink = countingSink();
    await Promise.all([
      pipeline(Readable.from(urlLines(size)), child.stdin),
      pipeline(child.stdout, sink),
      runChild(child),
    ]);
    expect('urls in output', sink.counter.count, size);
  }
);
