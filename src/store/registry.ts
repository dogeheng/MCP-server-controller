import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ensureDir } from '../util/paths.js';

export interface SessionRow {
  id: string;
  name: string | null;
  instance: string;
  kind: string;
  mode: string;
  sandbox: string;
  state: string;
  pid: number | null;
  pgid: number | null;
  pid_start: string | null;
  tty: string | null;
  command: string;
  cwd: string;
  created_at: number;
  ended_at: number | null;
  exit_code: number | null;
  signal: string | null;
  spill_dir: string;
  run_dir: string;
  /** JSON array of {pgid, start} for process groups observed in the session (crash cleanup). */
  groups?: string | null;
}

export interface InstanceRow {
  id: string;
  pid: number;
  pid_start: string | null;
  started_at: number;
  client: string | null;
}

export class Registry {
  readonly db: DatabaseSync;

  constructor(stateDir: string) {
    ensureDir(stateDir);
    this.db = new DatabaseSync(join(stateDir, 'registry.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, pid_start TEXT, started_at INTEGER NOT NULL, client TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT, instance TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL,
        sandbox TEXT NOT NULL, state TEXT NOT NULL, pid INTEGER, pgid INTEGER, pid_start TEXT, tty TEXT,
        command TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER,
        exit_code INTEGER, signal TEXT, spill_dir TEXT NOT NULL, run_dir TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
    `);
    try {
      this.db.exec('ALTER TABLE sessions ADD COLUMN groups TEXT');
    } catch {
      /* column already exists */
    }
  }

  addInstance(r: InstanceRow) {
    this.db
      .prepare('INSERT OR REPLACE INTO instances (id, pid, pid_start, started_at, client) VALUES (?, ?, ?, ?, ?)')
      .run(r.id, r.pid, r.pid_start, r.started_at, r.client);
  }

  setInstanceClient(id: string, client: string) {
    this.db.prepare('UPDATE instances SET client = ? WHERE id = ?').run(client, id);
  }

  instances(): InstanceRow[] {
    return this.db.prepare('SELECT * FROM instances').all() as unknown as InstanceRow[];
  }

  removeInstance(id: string) {
    this.db.prepare('DELETE FROM instances WHERE id = ?').run(id);
  }

  insert(r: SessionRow) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, name, instance, kind, mode, sandbox, state, pid, pgid, pid_start, tty, command, cwd,
          created_at, ended_at, exit_code, signal, spill_dir, run_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id, r.name, r.instance, r.kind, r.mode, r.sandbox, r.state, r.pid, r.pgid, r.pid_start, r.tty, r.command, r.cwd,
        r.created_at, r.ended_at, r.exit_code, r.signal, r.spill_dir, r.run_dir,
      );
  }

  update(id: string, fields: Partial<SessionRow>) {
    const keys = Object.keys(fields) as (keyof SessionRow)[];
    if (!keys.length) return;
    const sql = `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (fields[k] ?? null) as string | number | null), id);
  }

  get(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  }

  byState(states: string[]): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(...states) as unknown as SessionRow[];
  }

  recent(sinceMs: number): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions WHERE created_at >= ? ORDER BY created_at').all(sinceMs) as unknown as SessionRow[];
  }

  olderThan(ms: number): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE state NOT IN ('running','starting') AND COALESCE(ended_at, created_at) < ?")
      .all(ms) as unknown as SessionRow[];
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  setGroups(id: string, groups: { pgid: number; start?: string }[]) {
    this.db.prepare('UPDATE sessions SET groups = ? WHERE id = ?').run(JSON.stringify(groups), id);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
