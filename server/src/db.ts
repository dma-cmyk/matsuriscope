import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

/**
 * CHECK制約の拡張にはテーブル再構築が必要。参照元job_eventsは変更せず、
 * FKをトランザクションの外で一時停止して元のテーブル名・IDを維持する。
 */
export function initializeDatabase(database: DatabaseSync): void {
  database.exec(schema);
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'collect_jobs'").get() as { sql: string };
  const columns = database.prepare('PRAGMA table_info(collect_jobs)').all() as unknown as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  const required = ['scope', 'board_id', 'threads_total', 'threads_attempted', 'cancel_requested', 'current_thread'];
  if (required.some((name) => !names.has(name)) || !table.sql.includes("'interrupted'")) {
    const create = schema.match(/CREATE TABLE IF NOT EXISTS collect_jobs \([\s\S]*?\n\);/)?.[0];
    if (!create) throw new Error('collect_jobs schema is missing');
    const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'collect_jobs'").get() as
      | { seq: number }
      | undefined;
    database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec('BEGIN IMMEDIATE');
      database.exec(create.replace('IF NOT EXISTS collect_jobs', 'collect_jobs_migrating'));
      const target = database.prepare('PRAGMA table_info(collect_jobs_migrating)').all() as unknown as { name: string }[];
      const shared = target.map((column) => column.name).filter((name) => names.has(name));
      const columnSql = shared.map((name) => `"${name}"`).join(', ');
      database.exec(`INSERT INTO collect_jobs_migrating (${columnSql}) SELECT ${columnSql} FROM collect_jobs`);
      if (!names.has('threads_attempted')) {
        database.exec('UPDATE collect_jobs_migrating SET threads_attempted = threads_fetched, threads_total = threads_seen');
      }
      database.exec('DROP TABLE collect_jobs');
      database.exec('ALTER TABLE collect_jobs_migrating RENAME TO collect_jobs');
      if (sequence) {
        database.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'collect_jobs'").run(sequence.seq);
      }
      if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('foreign key violation while migrating collection jobs');
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }
  // Only process startup calls this initializer: no old worker can resume an in-flight request.
  database.exec(`
    UPDATE collect_jobs SET status = 'interrupted', finished_at = unixepoch(), current_thread = NULL,
      message = 'Process stopped before collection completed; start a new job to collect the current snapshot'
    WHERE status = 'running'
  `);
}

initializeDatabase(db);

// --- 型 ---
export interface BoardRow {
  id: number;
  source_id: string;
  server: string;
  board_key: string;
  name: string;
  category: string;
  url: string;
  enabled: number;
}

export interface ThreadRow {
  id: number;
  board_id: number;
  thread_key: string;
  title: string;
  url: string;
  res_count: number;
  ikioi: number;
  created_at: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface MediaRow {
  id: number;
  url_canonical: string;
  type: 'image' | 'gif' | 'video' | 'youtube' | 'twitter' | 'other';
  url: string;
  thumbnail_url: string | null;
  previewable: number;
  favorite: number;
  hidden: number;
  first_seen_at: number;
  last_seen_at: number;
  occ_count: number;
}

export interface JobRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'success' | 'partial' | 'error' | 'cancelled' | 'interrupted';
  trigger_type: 'schedule' | 'manual' | 'startup';
  scope: 'hot' | 'board';
  board_id: number | null;
  board_name: string | null;
  board_key: string | null;
  threads_total: number;
  threads_attempted: number;
  cancel_requested: number;
  current_thread: string | null;
  boards_checked: number;
  threads_seen: number;
  threads_fetched: number;
  media_found: number;
  media_new: number;
  errors: number;
  message: string | null;
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
