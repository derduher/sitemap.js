/**
 * Output sinks for the scenarios. Each one discards what it receives, like
 * /dev/null, but counts it so the scenario can check its own output.
 */
import { Transform, Writable } from 'node:stream';

/**
 * Count the occurrences of `needle` in a byte stream, including ones split
 * across chunk boundaries.
 */
class TagCounter {
  constructor(needle) {
    this.needle = Buffer.from(needle);
    this.tail = Buffer.alloc(0);
    this.count = 0;
    this.bytes = 0;
  }

  add(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const { needle } = this;
    this.bytes += buf.length;
    if (this.tail.length) {
      // The tail is shorter than the needle, so only matches that straddle
      // the boundary can be found in the joint.
      const joint = Buffer.concat([
        this.tail,
        buf.subarray(0, needle.length - 1),
      ]);
      this.count += occurrences(joint, needle);
    }
    this.count += occurrences(buf, needle);
    // Copy, so the tail doesn't keep the whole chunk alive.
    this.tail = Buffer.from(
      buf.subarray(Math.max(0, buf.length - (needle.length - 1)))
    );
  }
}

function occurrences(buf, needle) {
  let n = 0;
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) {
    n++;
  }
  return n;
}

/** A /dev/null that counts bytes and closing tags such as `</url>`. */
export function countingSink(tag = '</url>') {
  const counter = new TagCounter(tag);
  const sink = new Writable({
    write(chunk, _enc, cb) {
      counter.add(chunk);
      cb();
    },
  });
  sink.counter = counter;
  return sink;
}

/** A pass-through that counts closing tags on the way to a file. */
export function countingPassThrough(tag = '</url>') {
  const counter = new TagCounter(tag);
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      counter.add(chunk);
      cb(null, chunk);
    },
  });
  stream.counter = counter;
  return stream;
}

/** An object-mode sink that counts the items a parser emits. */
export function objectCounter() {
  const sink = new Writable({
    objectMode: true,
    write(_item, _enc, cb) {
      sink.count++;
      cb();
    },
  });
  sink.count = 0;
  return sink;
}
