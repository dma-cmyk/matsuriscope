import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

// .env 読み込み (依存を増やさない簡易パーサ)
function loadEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || m[1]!.startsWith('#')) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv(path.join(rootDir, '.env'));

function int(envKey: string, def: number, min: number, max: number): number {
  const v = Number(process.env[envKey]);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export const config = {
  rootDir,
  port: int('PORT', 8787, 1, 65535),
  dbFile: process.env.DB_FILE || path.join(rootDir, 'data', 'matsuriscope.db'),
  webDist: process.env.WEB_DIST || path.join(rootDir, 'web', 'dist'),

  collect: {
    intervalMinutes: int('COLLECT_INTERVAL_MINUTES', 30, 5, 24 * 60),
    requestDelayMs: int('COLLECT_REQUEST_DELAY_MS', 2000, 500, 60_000),
    maxBoardsPerJob: int('COLLECT_MAX_BOARDS', 40, 1, 300),
    maxThreadsPerBoard: int('COLLECT_MAX_THREADS_PER_BOARD', 5, 1, 50),
    maxDatPerJob: int('COLLECT_MAX_DAT', 60, 1, 500),
    httpTimeoutMs: int('HTTP_TIMEOUT_MS', 20_000, 3_000, 60_000),
    maxSubjectBytes: int('MAX_SUBJECT_BYTES', 8 * 1024 * 1024, 100_000, 64 * 1024 * 1024),
    maxDatBytes: int('MAX_DAT_BYTES', 12 * 1024 * 1024, 100_000, 64 * 1024 * 1024),
    userAgent:
      process.env.USER_AGENT ||
      'MatsuriScope/0.1 (+local research app; contact: localhost)',
  },
} as const;

export type AppConfig = typeof config;
