// XMLToSitemapItemStream -> SitemapStream over perf-data.xml, output
// discarded. One pass takes about a second, so --size sets how many passes
// over the corpus run in this process.
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { countingSink } from '../lib/sinks.mjs';
import { CORPUS_SIZE, PERF_XML } from '../fixtures.mjs';

await scenario(
  {
    name: 'round-trip',
    corpusWarnings: true,
    defaultSize: CORPUS_SIZE * 2,
    sizeMultipleOf: CORPUS_SIZE,
  },
  async ({ size, level, lib, logger, expect }) => {
    let urls = 0;
    for (let pass = 0; pass < size / CORPUS_SIZE; pass++) {
      const sink = countingSink();
      await pipeline(
        createReadStream(PERF_XML),
        new lib.XMLToSitemapItemStream({ level, logger }),
        new lib.SitemapStream({ level, logger }),
        sink
      );
      urls += sink.counter.count;
    }
    expect('urls in output', urls, size);
  }
);
