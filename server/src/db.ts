import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// --- 型 ---
export interface BoardRow {
  id: number;
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
  status: 'running' | 'success' | 'error';
  trigger_type: 'schedule' | 'manual' | 'startup';
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
