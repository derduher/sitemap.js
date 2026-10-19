// Run the `sitemap` CLI on a one-line input.
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { countingSink } from '../lib/sinks.mjs';
import { runChild } from '../lib/child.mjs';

await scenario(
  { name: 'cli-startup', levels: false },
  async ({ cli, expect }) => {
    const child = spawn(process.execPath, [cli], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.stdin.end('https://www.example.com/one-page\n');
    const sink = countingSink();
    await Promise.all([pipeline(child.stdout, sink), runChild(child)]);
    expect('urls in output', sink.counter.count, 1);
  }
);
