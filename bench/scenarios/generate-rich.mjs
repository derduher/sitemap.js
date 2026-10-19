// SitemapStream over generated items with images, video, news, and hreflang
// links, output discarded.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { countingSink } from '../lib/sinks.mjs';
import { richItems } from '../fixtures.mjs';

await scenario(
  { name: 'generate-rich', defaultSize: 100_000 },
  async ({ size, level, lib, logger, expect }) => {
    const sink = countingSink();
    await pipeline(
      Readable.from(richItems(size)),
      new lib.SitemapStream({ level, logger }),
      sink
    );
    expect('urls in output', sink.counter.count, size);
  }
);
