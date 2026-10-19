// lineSeparatedURLsToSitemapOptions -> SitemapStream over perf-data.json.txt.
// One pass takes well under a second, so --size sets how many passes over the
// corpus run in this process.
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { countingSink } from '../lib/sinks.mjs';
import { CORPUS_SIZE, PERF_JSON_LINES } from '../fixtures.mjs';

await scenario(
  {
    name: 'generate-from-lines',
    corpusWarnings: true,
    defaultSize: CORPUS_SIZE * 10,
    sizeMultipleOf: CORPUS_SIZE,
  },
  async ({ size, level, lib, logger, expect }) => {
    let urls = 0;
    for (let pass = 0; pass < size / CORPUS_SIZE; pass++) {
      const sink = countingSink();
      await pipeline(
        lib.lineSeparatedURLsToSitemapOptions(
          createReadStream(PERF_JSON_LINES)
        ),
        new lib.SitemapStream({ level, logger }),
        sink
      );
      urls += sink.counter.count;
    }
    expect('urls in output', urls, size);
  }
);
