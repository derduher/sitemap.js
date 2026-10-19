/** Small statistics helpers for benchmark results. */

/** Quantile with linear interpolation between order statistics (R type 7). */
export function quantile(values, q) {
  if (!values.length) {
    return NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const median = (values) => quantile(values, 0.5);

/** Median, interquartile range, minimum, and sample count. */
export function summarize(values) {
  return {
    median: median(values),
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
    iqr: quantile(values, 0.75) - quantile(values, 0.25),
    min: Math.min(...values),
    n: values.length,
  };
}

/** mulberry32: a small, fast, seeded PRNG for reproducible fixtures and bootstrap intervals. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Relative difference in medians, (head - base) / base, with a percentile
 * bootstrap confidence interval. Samples are independent processes, so
 * resampling each side separately is valid.
 */
export function relativeDifference(
  base,
  head,
  { iterations = 10_000, confidence = 0.95 } = {}
) {
  const rand = prng(42);
  const resample = (values) => {
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      out[i] = values[Math.floor(rand() * values.length)];
    }
    return median(out);
  };
  const diffs = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const b = resample(base);
    diffs[i] = (resample(head) - b) / b;
  }
  const alpha = (1 - confidence) / 2;
  return {
    diff: (median(head) - median(base)) / median(base),
    low: quantile(diffs, alpha),
    high: quantile(diffs, 1 - alpha),
  };
}
