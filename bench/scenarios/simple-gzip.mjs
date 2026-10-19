// simpleSitemapAndIndex over generated URLs with gzip on, writing to a
// temporary directory. It has no error-level option, so it always runs at the
// default level.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { scenario } from '../lib/scenario.mjs';
import { urlItems } from '../fixtures.mjs';

await scenario(
  { name: 'simple-gzip', defaultSize: 1_000_000, levels: false },
  async ({ size, lib, logger, expect }) => {
    const dir = await mkdtemp(join(tmpdir(), 'sitemap-bench-'));
    // destinationDir must be relative.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await lib.simpleSitemapAndIndex({
        hostname: 'https://www.example.com',
        sourceData: Readable.from(urlItems(size)),
        destinationDir: 'out',
        gzip: true,
        logger,
      });
      const limit = lib.DEFAULT_SITEMAP_ITEM_LIMIT ?? 45_000;
      const files = Math.ceil(size / limit);
      const written = await readdir(join(dir, 'out'));
      // The sitemaps plus the index.
      expect(
        'gzipped files',
        written.filter((f) => f.endsWith('.gz')).length,
        files + 1
      );
      // Gunzipping every sitemap would add measurable work; the file count
      // already bounds the URL count to the last file.
      const index = gunzipSync(
        await readFile(join(dir, 'out', 'sitemap-index.xml.gz'))
      ).toString();
      expect('index entries', index.split('</sitemap>').length - 1, files);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  }
);
