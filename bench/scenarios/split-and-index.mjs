// SitemapAndIndexStream over generated URLs, with the default per-file limit,
// writing sitemap files and the index to a temporary directory.
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { countingPassThrough } from '../lib/sinks.mjs';
import { urlItems } from '../fixtures.mjs';

await scenario(
  { name: 'split-and-index', defaultSize: 1_000_000 },
  async ({ size, level, lib, logger, expect }) => {
    const dir = await mkdtemp(join(tmpdir(), 'sitemap-bench-'));
    try {
      const counters = [];
      const stream = new lib.SitemapAndIndexStream({
        level,
        logger,
        getSitemapStream: (i) => {
          const sitemap = new lib.SitemapStream({ level, logger });
          const counter = countingPassThrough();
          counters.push(counter.counter);
          const file = `sitemap-${i}.xml`;
          const ws = createWriteStream(join(dir, file));
          sitemap.pipe(counter).pipe(ws);
          return [`https://www.example.com/${file}`, sitemap, ws];
        },
      });
      const index = countingPassThrough('</sitemap>');
      await pipeline(
        Readable.from(urlItems(size)),
        stream,
        index,
        createWriteStream(join(dir, 'sitemap-index.xml'))
      );
      const limit = lib.DEFAULT_SITEMAP_ITEM_LIMIT ?? 45_000;
      const files = Math.ceil(size / limit);
      expect('sitemap files', counters.length, files);
      expect('index entries', index.counter.count, files);
      expect(
        'urls in sitemap files',
        counters.reduce((sum, c) => sum + c.count, 0),
        size
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);
