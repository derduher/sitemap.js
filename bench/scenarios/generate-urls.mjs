// SitemapStream over generated URLs, output discarded.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { countingSink } from '../lib/sinks.mjs';
import { urlItems } from '../fixtures.mjs';

await scenario(
  { name: 'generate-urls', defaultSize: 1_000_000 },
  async ({ size, level, lib, logger, expect }) => {
    const sink = countingSink();
    await pipeline(
      Readable.from(urlItems(size)),
      new lib.SitemapStream({ level, logger }),
      sink
    );
    expect('urls in output', sink.counter.count, size);
  }
);
