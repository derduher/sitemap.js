// XMLToSitemapIndexStream over a cached index with 50,000 entries, the
// protocol maximum. One pass takes well under a second, so --size sets how
// many passes run in this process. `node bench/fixtures.mjs parse-index`
// writes the fixture.
import { createReadStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { scenario } from '../lib/scenario.mjs';
import { objectCounter } from '../lib/sinks.mjs';
import { INDEX_FIXTURE, INDEX_SIZE } from '../fixtures.mjs';

await scenario(
  {
    name: 'parse-index',
    defaultSize: INDEX_SIZE * 4,
    sizeMultipleOf: INDEX_SIZE,
  },
  async ({ size, level, lib, logger, expect }) => {
    if (!existsSync(INDEX_FIXTURE)) {
      throw new Error('Run `node bench/fixtures.mjs parse-index` first.');
    }
    let items = 0;
    for (let pass = 0; pass < size / INDEX_SIZE; pass++) {
      const sink = objectCounter();
      await pipeline(
        createReadStream(INDEX_FIXTURE),
        new lib.XMLToSitemapIndexStream({ level, logger }),
        sink
      );
      items += sink.count;
    }
    expect('parsed index entries', items, size);
  }
);
