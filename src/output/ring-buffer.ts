export type StreamId = 'pty' | 'stdout' | 'stderr';

export interface Chunk {
  seq: number; // byte offset of data[0] in the session's output space
  stream: StreamId;
  data: Buffer;
}

export interface Slice {
  start: number;
  end: number;
  parts: { stream: StreamId; data: Buffer }[];
}

/**
 * In-memory window over the most recent output. Every byte has a monotonically
 * increasing sequence number (the cursor space); old chunks are evicted when the
 * window exceeds its capacity, but sequence numbers are never reused.
 */
export class RingBuffer {
  private chunks: Chunk[] = [];
  private head = 0;
  private bytes = 0;
  private _endSeq = 0;
  private _startSeq = 0;

  constructor(private capacity: number) {}

  get startSeq() {
    return this._startSeq;
  }
  get endSeq() {
    return this._endSeq;
  }
  get size() {
    return this.bytes;
  }

  append(stream: StreamId, data: Buffer): number {
    const seq = this._endSeq;
    if (data.length === 0) return seq;
    this.chunks.push({ seq, stream, data });
    this.bytes += data.length;
    this._endSeq += data.length;
    this.evict(this.capacity);
    return seq;
  }

  /** Drops oldest chunks until at most `limit` bytes remain. */
  evict(limit: number) {
    while (this.bytes > limit && this.head < this.chunks.length) {
      const c = this.chunks[this.head]!;
      this.bytes -= c.data.length;
      this.head++;
      this._startSeq = c.seq + c.data.length;
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    if (this.head >= this.chunks.length) this._startSeq = this._endSeq;
  }

  setCapacity(cap: number) {
    this.capacity = cap;
    this.evict(cap);
  }

  private indexOf(seq: number): number {
    let lo = this.head;
    let hi = this.chunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.chunks[mid]!;
      if (seq < c.seq) hi = mid - 1;
      else if (seq >= c.seq + c.data.length) lo = mid + 1;
      else return mid;
    }
    return lo;
  }

  /**
   * Returns up to `maxBytes` (counting only bytes of matching streams) starting at
   * `from`. Returns null if `from` is older than the in-memory window.
   */
  read(from: number, maxBytes: number, filter?: (s: StreamId) => boolean): Slice | null {
    if (from < this._startSeq) return null;
    const parts: Slice['parts'] = [];
    let pos = Math.min(from, this._endSeq);
    let taken = 0;
    for (let i = this.indexOf(pos); i < this.chunks.length && taken < maxBytes; i++) {
      const c = this.chunks[i]!;
      const off = Math.max(0, pos - c.seq);
      if (off >= c.data.length) continue;
      if (filter && !filter(c.stream)) {
        pos = c.seq + c.data.length;
        continue;
      }
      const n = Math.min(c.data.length - off, maxBytes - taken);
      parts.push({ stream: c.stream, data: c.data.subarray(off, off + n) });
      taken += n;
      pos = c.seq + off + n;
    }
    return { start: from, end: pos, parts };
  }
}
