import xterm from '@xterm/headless';

export interface ScreenSnapshot {
  view: 'screen';
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  alt_screen: boolean;
  title?: string;
  lines: string[];
  changed_rows?: number[];
}

/**
 * Headless terminal emulator mirroring the PTY. Answers terminal queries
 * (cursor position, device attributes) through `onReply`, which many TUIs and
 * line editors block on, and produces screen snapshots for full-screen apps.
 */
export class ScreenModel {
  private term: InstanceType<typeof xterm.Terminal>;
  private pending: string[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private title: string | undefined;
  private lastLines: string[] = [];

  constructor(cols: number, rows: number, onReply: (data: string) => void) {
    this.term = new xterm.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.term.onData((d) => onReply(d));
    this.term.onTitleChange((t) => (this.title = t));
  }

  write(data: string) {
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (this.pendingBytes >= 64 * 1024) this.flushNow();
    else if (!this.timer) this.timer = setTimeout(() => this.flushNow(), 16);
  }

  private flushNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    const data = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;
    this.term.write(data);
  }

  /** Resolves once everything written so far has been parsed. */
  settle(): Promise<void> {
    this.flushNow();
    return new Promise((r) => this.term.write('', () => r()));
  }

  resize(cols: number, rows: number) {
    this.flushNow();
    this.term.resize(cols, rows);
  }

  get modes() {
    return this.term.modes;
  }

  get altScreen() {
    return this.term.buffer.active.type === 'alternate';
  }

  /** Text of the line the cursor is on (best effort, may lag by one flush). */
  cursorLine(): string {
    const b = this.term.buffer.active;
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '';
  }

  /** Text left of the cursor on the cursor line, trailing spaces kept. */
  textBeforeCursor(): string {
    const b = this.term.buffer.active;
    if (b.cursorX <= 0) return '';
    return b.getLine(b.baseY + b.cursorY)?.translateToString(false, 0, b.cursorX) ?? '';
  }

  async snapshot(changesOnly = false): Promise<ScreenSnapshot> {
    await this.settle();
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    const changed: number[] = [];
    for (let y = 0; y < lines.length; y++) if (lines[y] !== this.lastLines[y]) changed.push(y);
    this.lastLines = lines;
    let outLines = lines;
    if (changesOnly) outLines = lines.map((l, y) => (changed.includes(y) ? l : ''));
    // Trim trailing empty rows to save tokens.
    let last = outLines.length;
    while (last > 0 && outLines[last - 1] === '' && last - 1 > b.cursorY) last--;
    return {
      view: 'screen',
      cols: this.term.cols,
      rows: this.term.rows,
      cursor: { x: b.cursorX, y: b.cursorY },
      alt_screen: b.type === 'alternate',
      title: this.title,
      lines: outLines.slice(0, last),
      changed_rows: changesOnly || this.lastLines.length ? changed : undefined,
    };
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.term.dispose();
  }
}
