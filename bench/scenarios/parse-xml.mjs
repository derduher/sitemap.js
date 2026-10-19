// XMLToSitemapItemStream over a sitemap built from the perf-data.xml corpus.
// The input comes from a child generator process, so it never touches disk
// and the corpus isn't held in this process's memory.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { objectCounter } from '../lib/sinks.mjs';
import { runChild } from '../lib/child.mjs';

await scenario(
  { name: 'parse-xml', corpusWarnings: true, defaultSize: 1_000_000 },
  async ({ size, level, lib, logger, expect }) => {
    const generator = spawn(
      process.execPath,
      [join(import.meta.dirname, '..', 'fixtures.mjs'), '--xml', String(size)],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    const sink = objectCounter();
    await Promise.all([
      pipeline(
        generator.stdout,
        // The default cap is the protocol's 50,000 entries.
        new lib.XMLToSitemapItemStream({ level, logger, maxEntries: Infinity }),
        sink
      ),
      runChild(generator),
    ]);
    expect('parsed items', sink.count, size);
  }
);
