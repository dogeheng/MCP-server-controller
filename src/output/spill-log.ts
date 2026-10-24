import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../util/paths.js';
import type { Slice, StreamId } from './ring-buffer.js';

const STREAM_CODES: StreamId[] = ['pty', 'stdout', 'stderr'];
const SEG_RE = /^seg-(\d{16})\.log$/;

interface Segment {
  base: number;
  size: number;
  path: string;
}

/**
 * Append-only on-disk copy of a session's output, split into segments named by
 * their base sequence number so the oldest can be deleted cheaply. File offsets
 * equal sequence offsets within a segment, so locating a cursor is O(log n).
 * Writes are synchronous: a slow disk slows the PTY reader, which is natural
 * backpressure for the child process.
 */
export class SpillLog {
  private segs: Segment[] = [];
  private fd: number | undefined;
  private runs: { seq: number; stream: StreamId }[] = [];
  private runsFd: number | undefined;
  private _endSeq = 0;
  private total = 0;

  constructor(
    readonly dir: string,
    private maxBytes: number,
    private segmentBytes = 16 * 1024 * 1024,
    readonly readOnly = false,
  ) {
    if (!readOnly) ensureDir(dir);
    this.scan();
  }

  get enabled() {
    return this.maxBytes > 0 || this.readOnly;
  }
  get startSeq() {
    return this.segs.length ? this.segs[0]!.base : this._endSeq;
  }
  get endSeq() {
    return this._endSeq;
  }

  private scan() {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      const m = SEG_RE.exec(f);
      if (!m) continue;
      const path = join(this.dir, f);
      const fd = openSync(path, 'r');
      const size = fstatSync(fd).size;
      closeSync(fd);
      this.segs.push({ base: Number(m[1]), size, path });
    }
    this.segs.sort((a, b) => a.base - b.base);
    const last = this.segs[this.segs.length - 1];
    this._endSeq = last ? last.base + last.size : 0;
    this.total = this.segs.reduce((n, s) => n + s.size, 0);
    const idx = join(this.dir, 'streams.idx');
    if (existsSync(idx)) {
      const buf = readFileSync(idx);
      for (let off = 0; off + 9 <= buf.length; off += 9) {
        this.runs.push({ seq: buf.readDoubleLE(off), stream: STREAM_CODES[buf[off + 8]!] ?? 'pty' });
      }
    }
  }

  append(seq: number, stream: StreamId, data: Buffer) {
    if (this.readOnly || this.maxBytes <= 0 || data.length === 0) {
      this._endSeq = Math.max(this._endSeq, seq + data.length);
      return;
    }
    if (seq !== this._endSeq) {
      // A gap can only happen if spilling was toggled; start a fresh segment.
      this.rotate(seq);
    }
    const last = this.runs[this.runs.length - 1];
    if (!last || last.stream !== stream) {
      this.runs.push({ seq, stream });
      const rec = Buffer.alloc(9);
      rec.writeDoubleLE(seq, 0);
      rec[8] = STREAM_CODES.indexOf(stream);
      if (this.runsFd === undefined) this.runsFd = openSync(join(this.dir, 'streams.idx'), 'a', 0o600);
      writeSync(this.runsFd, rec);
    }
    let cur = this.segs[this.segs.length - 1];
    if (this.fd === undefined || !cur || cur.size >= this.segmentBytes) {
      this.rotate(seq);
      cur = this.segs[this.segs.length - 1]!;
    }
    writeSync(this.fd!, data);
    cur.size += data.length;
    this.total += data.length;
    this._endSeq = seq + data.length;
    while (this.total > this.maxBytes && this.segs.length > 1) {
      const old = this.segs.shift()!;
      this.total -= old.size;
      try {
        unlinkSync(old.path);
      } catch {
        /* ignore */
      }
    }
  }

  private rotate(base: number) {
    if (this.fd !== undefined) closeSync(this.fd);
    const path = join(this.dir, `seg-${String(base).padStart(16, '0')}.log`);
    this.fd = openSync(path, 'a', 0o600);
    this.segs.push({ base, size: 0, path });
    this._endSeq = base;
  }

  streamAt(seq: number): StreamId {
    let lo = 0;
    let hi = this.runs.length - 1;
    let ans: StreamId = 'pty';
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.runs[mid]!.seq <= seq) {
        ans = this.runs[mid]!.stream;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  private nextRunAfter(seq: number): number {
    for (const r of this.runs) if (r.seq > seq) return r.seq;
    return Infinity;
  }

  read(from: number, maxBytes: number, filter?: (s: StreamId) => boolean, until = Infinity): Slice | null {
    if (!this.segs.length || from < this.startSeq) return null;
    const parts: Slice['parts'] = [];
    let pos = Math.min(from, this._endSeq);
    let taken = 0;
    const stop = Math.min(until, this._endSeq);
    while (pos < stop && taken < maxBytes) {
      const seg = this.segs.find((s) => pos >= s.base && pos < s.base + s.size);
      if (!seg) break;
      const stream = this.streamAt(pos);
      const runEnd = Math.min(this.nextRunAfter(pos), seg.base + seg.size, stop);
      if (filter && !filter(stream)) {
        pos = runEnd;
        continue;
      }
      const n = Math.min(runEnd - pos, maxBytes - taken);
      const buf = Buffer.alloc(n);
      const fd = openSync(seg.path, 'r');
      try {
        readSync(fd, buf, 0, n, pos - seg.base);
      } finally {
        closeSync(fd);
      }
      parts.push({ stream, data: buf });
      taken += n;
      pos += n;
    }
    return { start: from, end: pos, parts };
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    if (this.runsFd !== undefined) closeSync(this.runsFd);
    this.fd = this.runsFd = undefined;
  }
}
