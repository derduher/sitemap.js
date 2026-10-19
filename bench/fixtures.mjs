#!/usr/bin/env node
/**
 * Benchmark fixtures: seeded synthetic input, so every run sees identical
 * data without large files in the repository.
 *
 * Three ways to use it, matching where the input's memory may live:
 *
 * - Import the generators (`urlItems`, `urlLines`, `richItems`) to stream
 *   input inside a scenario process, one item at a time.
 * - `node bench/fixtures.mjs <scenario>` writes that scenario's cached input
 *   to bench/.cache/. hyperfine runs it as `--setup`, outside the measurement.
 *   Scenarios with no cached input accept it as a no-op.
 * - `node bench/fixtures.mjs --xml <size>` writes a sitemap with `size` URL
 *   entries to stdout. Scenarios spawn it as a child process for input too
 *   large to cache, such as parse-xml at 1M items (about 1 GB).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { CACHE_DIR, MOCKS_DIR } from './lib/scenario.mjs';
import { prng } from './lib/stats.mjs';

/** Number of entries in tests/mocks/perf-data.xml and perf-data.json.txt */
export const CORPUS_SIZE = 21_753;
export const PERF_XML = join(MOCKS_DIR, 'perf-data.xml');
export const PERF_JSON_LINES = join(MOCKS_DIR, 'perf-data.json.txt');
/** Index entries in the parse-index fixture: the protocol maximum */
export const INDEX_SIZE = 50_000;
export const INDEX_FIXTURE = join(CACHE_DIR, `index-${INDEX_SIZE}.xml`);

const WORDS = [
  'products',
  'blog',
  'news',
  'category',
  'item',
  'archive',
  'tags',
  'shop',
  'docs',
  'guides',
  'reference',
  'help',
  'about',
  'events',
  'videos',
  'media',
  'outdoor',
  'kitchen',
  'garden',
  'travel',
  'reviews',
  'deals',
  'support',
];
// Non-ASCII segments exercise URL normalization and percent-encoding.
const NON_ASCII = ['café', 'straße', '日本語', 'niño', 'über', 'música'];
const HOST = 'https://www.example.com';

function makeUrl(rand, i) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const depth = 1 + Math.floor(rand() * 5);
  let path = '';
  for (let d = 0; d < depth; d++) {
    path += '/' + (rand() < 0.1 ? pick(NON_ASCII) : pick(WORDS));
  }
  // The index keeps every URL unique.
  path += `/${pick(WORDS)}-${i}`;
  const r = rand();
  if (r < 0.2) {
    // `&` must be escaped in XML output.
    path += `?page=${Math.floor(rand() * 50)}&sort=${pick(WORDS)}`;
  } else if (r < 0.3) {
    path += `?q=${pick(WORDS)}`;
  }
  return HOST + path;
}

/** Yield `size` URL strings. */
export function* urlItems(size, seed = 1) {
  const rand = prng(seed);
  for (let i = 0; i < size; i++) {
    yield makeUrl(rand, i);
  }
}

/**
 * Yield the same URLs as `urlItems`, newline-separated, in chunks of about
 * 64 KB, for a process's stdin.
 */
export function* urlLines(size, seed = 1) {
  let chunk = '';
  for (const url of urlItems(size, seed)) {
    chunk += url + '\n';
    if (chunk.length >= 65_536) {
      yield chunk;
      chunk = '';
    }
  }
  if (chunk) {
    yield chunk;
  }
}

const LANGS = ['en', 'de', 'fr', 'es', 'ja', 'pt-br'];

/** Yield `size` items with images, video, news, and hreflang links. */
export function* richItems(size, seed = 2) {
  const rand = prng(seed);
  for (let i = 0; i < size; i++) {
    const url = makeUrl(rand, i);
    const date = new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString();
    yield {
      url,
      lastmod: date,
      changefreq: 'weekly',
      priority: 0.5,
      img: [
        { url: `${HOST}/img/${i}-a.jpg`, caption: `Image A & B for ${i}` },
        { url: `${HOST}/img/${i}-b.png`, title: `Second image ${i}` },
      ],
      video: [
        {
          thumbnail_loc: `${HOST}/thumbs/${i}.jpg`,
          title: `Video ${i}: <highlights> & extras`,
          description:
            `A seeded description for item ${i}, long enough to look like real copy. `.repeat(
              1 + Math.floor(rand() * 4)
            ),
          player_loc: `${HOST}/player?id=${i}&autoplay=0`,
          duration: 30 + Math.floor(rand() * 3000),
          publication_date: date,
          tag: ['seeded', 'bench'],
          family_friendly: 'yes',
        },
      ],
      news: {
        publication: { name: 'Example Times', language: 'en' },
        publication_date: date,
        title: `Headline number ${i}`,
      },
      links: LANGS.map((lang) => ({ lang, url: `${HOST}/${lang}/item-${i}` })),
    };
  }
}

/**
 * Write a sitemap with `size` entries to `out`, built by repeating the
 * perf-data.xml corpus. Every pass after the first appends `/r<pass>` to each
 * `<loc>`, so URLs stay unique. Writes respect backpressure.
 *
 * The corpus stays one Buffer and entries are written as slices of it, so
 * this process stays well below the parser's peak memory. Otherwise
 * parse-xml's peak RSS would measure the generator instead of the library.
 */
export async function writeXml(size, out) {
  const corpus = readFileSync(PERF_XML);
  const URL_OPEN = Buffer.from('<url>');
  const URL_CLOSE = Buffer.from('</url>');
  const LOC_CLOSE = Buffer.from('</loc>');
  const first = corpus.indexOf(URL_OPEN);
  // Per entry: start, end of the <loc> value, end.
  const offsets = [];
  for (let i = first; i !== -1;) {
    const end = corpus.indexOf(URL_CLOSE, i) + URL_CLOSE.length;
    offsets.push([i, corpus.indexOf(LOC_CLOSE, i), end]);
    i = corpus.indexOf(URL_OPEN, end);
  }

  const SEPARATOR = Buffer.from('\n  ');
  // Batch slices with cork() so they go out as one writev, without copying.
  let pending = 0;
  const push = (buf) => {
    out.write(buf);
    pending += buf.length;
  };
  const flush = async () => {
    out.uncork();
    pending = 0;
    if (out.writableNeedDrain) {
      await once(out, 'drain');
    }
    out.cork();
  };

  out.cork();
  push(corpus.subarray(0, first));
  for (let n = 0; n < size; n++) {
    const pass = Math.floor(n / offsets.length);
    const [start, locEnd, end] = offsets[n % offsets.length];
    push(SEPARATOR);
    if (pass === 0) {
      push(corpus.subarray(start, end));
    } else {
      push(corpus.subarray(start, locEnd));
      push(Buffer.from(`/r${pass}`));
      push(corpus.subarray(locEnd, end));
    }
    if (pending >= 262_144) {
      await flush();
    }
  }
  push(Buffer.from('\n</urlset>\n'));
  out.uncork();
}

/** Build a sitemap index with `INDEX_SIZE` entries. */
function indexXml() {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
  ];
  for (let i = 0; i < INDEX_SIZE; i++) {
    const lastmod = new Date(Date.UTC(2024, 0, 1) + i * 3_600_000)
      .toISOString()
      .slice(0, 10);
    parts.push(
      `  <sitemap><loc>${HOST}/sitemaps/sitemap-${i}.xml.gz</loc><lastmod>${lastmod}</lastmod></sitemap>\n`
    );
  }
  parts.push('</sitemapindex>\n');
  return parts.join('');
}

/** Cached inputs by scenario name. Scenarios not listed need none. */
const CACHED = {
  'parse-index': [{ path: INDEX_FIXTURE, build: indexXml }],
};

function setup(scenarioName) {
  for (const { path, build } of CACHED[scenarioName] ?? []) {
    if (!existsSync(path)) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(path, build());
    }
  }
}

if (import.meta.main) {
  const [arg, value] = process.argv.slice(2);
  if (arg === '--xml') {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) {
      console.error('Usage: node bench/fixtures.mjs --xml <size>');
      process.exit(2);
    }
    await writeXml(size, process.stdout);
  } else if (arg) {
    setup(arg);
  } else {
    console.error('Usage: node bench/fixtures.mjs <scenario> | --xml <size>');
    process.exit(2);
  }
}
