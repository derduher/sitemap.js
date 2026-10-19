// Baseline: start Node.js, load the scenario harness and the package, exit.
// Other scenarios subtract this one's time and memory.
import { scenario } from '../lib/scenario.mjs';

await scenario({ name: 'startup', levels: false }, async ({ lib, expect }) => {
  expect('SitemapStream export', typeof lib.SitemapStream, 'function');
});
