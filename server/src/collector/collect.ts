import { db, type BoardRow, type JobRow, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { adapters } from '../adapters/index.js';
import type { SourceAdapter, SourceBoard, SourcePost, SourceThreadRef } from '../adapters/types.js';
import { calcIkioi } from '../score.js';

/** Both hot jobs and complete-current-board jobs share this process-local exclusion lock. */
let running = false;

export function isCollectRunning(): boolean {
  return running;
}

export class CollectStartError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409) {
    super(message);
  }
}

function enabledBoardKeys(): Set<string> | null {
  const json = getSetting('boards_enabled_json');
  return json === null ? null : new Set(JSON.parse(json) as string[]);
}

function upsertBoards(adapter: SourceAdapter, boards: SourceBoard[], enabledKeys: Set<string> | null): void {
  const stmt = db.prepare(`
    INSERT INTO boards(source_id, server, board_key, name, category, url, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, server, board_key) DO UPDATE SET
      name = excluded.name, category = excluded.category, url = excluded.url, enabled = excluded.enabled
  `);
  db.exec('BEGIN');
  try {
    // Boards removed from the official menu or excluded by source policy must not remain enabled.
    db.prepare('UPDATE boards SET enabled = 0 WHERE source_id = ?').run(adapter.sourceId);
    for (const board of boards) {
      if (!adapter.isBoardEligible(board)) continue;
      const enabled = enabledKeys === null || enabledKeys.has(`${board.server}/${board.boardKey}`) ? 1 : 0;
      stmt.run(adapter.sourceId, board.server, board.boardKey, board.name, board.category, board.url, enabled);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Refresh only official menus; this never fetches subject.txt, dat, or media. */
export async function refreshBoards(): Promise<void> {
  if (running) throw new CollectStartError('collection or board refresh already running', 409);
  running = true;
  try {
    const keys = enabledBoardKeys();
    for (const adapter of adapters) upsertBoards(adapter, await adapter.listBoards(), keys);
  } finally {
    running = false;
  }
}

function boardMapByKey(sourceId: string): Map<string, BoardRow> {
  const rows = db.prepare('SELECT * FROM boards WHERE source_id = ?').all(sourceId) as unknown as BoardRow[];
  return new Map(rows.map((row) => [`${row.server}/${row.board_key}`, row]));
}

const upThread = db.prepare(`
  INSERT INTO threads(board_id, thread_key, title, url, res_count, ikioi, created_at, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  ON CONFLICT(board_id, thread_key) DO UPDATE SET
    title = excluded.title, url = excluded.url, res_count = excluded.res_count, ikioi = excluded.ikioi,
    last_seen_at = unixepoch()
  RETURNING id
`);
const insMedia = db.prepare(`
  INSERT INTO media(url_canonical, type, url, thumbnail_url, previewable, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
  ON CONFLICT(url_canonical) DO UPDATE SET last_seen_at = unixepoch()
  RETURNING id
`);
const findMedia = db.prepare('SELECT id FROM media WHERE url_canonical = ?');
const insOcc = db.prepare(`
  INSERT INTO media_occurrences(media_id, thread_id, res_no, found_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT(media_id, thread_id, res_no) DO NOTHING
`);
const updOccCount = db.prepare(
  'UPDATE media SET occ_count = (SELECT COUNT(DISTINCT thread_id) FROM media_occurrences WHERE media_id = ?) WHERE id = ?',
);

/** A thread's media, occurrences and counters commit together, or not at all. */
function saveThread(adapter: SourceAdapter, boardId: number, ref: SourceThreadRef, posts: SourcePost[]): { found: number; added: number } {
  let found = 0;
  let added = 0;
  db.exec('BEGIN');
  try {
    const resCount = Math.max(ref.resCount, posts.length);
    const thread = upThread.get(
      boardId, ref.threadKey, ref.title, adapter.threadUrl(ref), resCount,
      calcIkioi(resCount, Number(ref.threadKey), Math.floor(Date.now() / 1000)), Number(ref.threadKey),
    ) as { id: number };
    for (const post of posts) {
      for (const media of adapter.extractMedia(post)) {
        const existing = findMedia.get(media.canonicalUrl);
        const row = insMedia.get(media.canonicalUrl, media.type, media.url, media.thumbnailUrl, media.previewable ? 1 : 0) as { id: number };
        insOcc.run(row.id, thread.id, media.resNo);
        updOccCount.run(row.id, row.id);
        found += 1;
        if (!existing) added += 1;
      }
    }
    db.exec('COMMIT');
    return { found, added };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rotateBoards(boards: SourceBoard[]): SourceBoard[] {
  const max = config.collect.maxBoardsPerJob;
  if (boards.length <= max) return boards;
  const offset = Number(getSetting('board_rotation_offset') ?? '0') || 0;
  const start = offset % boards.length;
  setSetting('board_rotation_offset', String(start + max));
  const rotated = boards.slice(start, start + max);
  if (rotated.length < max) rotated.push(...boards.slice(0, max - rotated.length));
  return rotated;
}

type FinishedStatus = Exclude<JobRow['status'], 'running' | 'interrupted'>;
export interface CollectResult {
  jobId: number;
  status: FinishedStatus;
  boardsChecked: number;
  threadsSeen: number;
  threadsAttempted: number;
  threadsFetched: number;
  mediaFound: number;
  mediaNew: number;
  errors: number;
  message: string | null;
}

interface BoardTarget {
  row: BoardRow;
  board: SourceBoard;
  adapter: SourceAdapter;
}

function allocateJob(scope: 'hot' | 'board', trigger: JobRow['trigger_type'], boardId: number | null): number {
  if (running) throw new CollectStartError('collection or board refresh already running', 409);
  running = true;
  try {
    return Number(db.prepare(
      'INSERT INTO collect_jobs(status, scope, trigger_type, board_id) VALUES (\'running\', ?, ?, ?)',
    ).run(scope, trigger, boardId).lastInsertRowid);
  } catch (error) {
    running = false;
    throw error;
  }
}

/** Validate the DB identity, source registry, settings and source URL policy before allocation. */
export function startBoardCollect(boardId: number): { jobId: number; completion: Promise<CollectResult> } {
  if (!Number.isSafeInteger(boardId) || boardId <= 0) throw new CollectStartError('boardId must be a positive integer', 400);
  if (running) throw new CollectStartError('collection or board refresh already running', 409);
  const row = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as unknown as BoardRow | undefined;
  if (!row) throw new CollectStartError('board not found', 404);
  const adapter = adapters.find((candidate) => candidate.sourceId === row.source_id);
  const board: SourceBoard = {
    server: row.server, boardKey: row.board_key, name: row.name, category: row.category, url: row.url,
  };
  const keys = enabledBoardKeys();
  if (row.enabled !== 1 || !adapter || !adapter.isBoardEligible(board) || (keys !== null && !keys.has(`${row.server}/${row.board_key}`))) {
    throw new CollectStartError('board is disabled or not eligible for this source', 400);
  }
  const jobId = allocateJob('board', 'manual', boardId);
  // Allocation and exclusion are synchronous; async work cannot race another POST or scheduled job.
  const completion = Promise.resolve().then(() => executeJob(jobId, { row, board, adapter }));
  return { jobId, completion };
}

export function requestBoardCancellation(jobId: number): void {
  const job = db.prepare('SELECT scope, status FROM collect_jobs WHERE id = ?').get(jobId) as
    | { scope: string; status: string }
    | undefined;
  if (!job) throw new CollectStartError('job not found', 404);
  if (job.scope !== 'board' || job.status !== 'running') throw new CollectStartError('only running board jobs can be cancelled', 409);
  db.prepare('UPDATE collect_jobs SET cancel_requested = 1 WHERE id = ?').run(jobId);
}

export async function runCollect(trigger: JobRow['trigger_type']): Promise<CollectResult | null> {
  if (running) return null;
  return executeJob(allocateJob('hot', trigger, null));
}

async function executeJob(jobId: number, target?: BoardTarget): Promise<CollectResult> {
  let boardsChecked = 0;
  let threadsSeen = 0;
  let threadsTotal = 0;
  let threadsAttempted = 0;
  let threadsFetched = 0;
  let mediaFound = 0;
  let mediaNew = 0;
  let errors = 0;
  let currentThread: string | null = null;
  const logEvent = (level: 'info' | 'warn' | 'error', message: string): void => {
    db.prepare('INSERT INTO job_events(job_id, level, message) VALUES (?, ?, ?)').run(jobId, level, message);
    if (level !== 'info') console[level](`[collect#${jobId}] ${message}`);
  };
  const persist = (): void => {
    db.prepare(`UPDATE collect_jobs SET boards_checked = ?, threads_seen = ?, threads_total = ?,
      threads_attempted = ?, threads_fetched = ?, media_found = ?, media_new = ?, errors = ?, current_thread = ? WHERE id = ?`)
      .run(boardsChecked, threadsSeen, threadsTotal, threadsAttempted, threadsFetched, mediaFound, mediaNew, errors, currentThread, jobId);
  };
  const cancelled = (): boolean => {
    if (!target) return false;
    const job = db.prepare('SELECT cancel_requested FROM collect_jobs WHERE id = ?').get(jobId);
    return job?.cancel_requested === 1;
  };
  const finalize = (status: FinishedStatus, message: string): CollectResult => {
    currentThread = null;
    persist();
    db.prepare('UPDATE collect_jobs SET finished_at = unixepoch(), status = ?, message = ? WHERE id = ?').run(status, message, jobId);
    return { jobId, status, boardsChecked, threadsSeen, threadsAttempted, threadsFetched, mediaFound, mediaNew, errors, message };
  };
  const attempt = async (adapter: SourceAdapter, boardId: number, ref: SourceThreadRef): Promise<void> => {
    currentThread = `${ref.board.server}/${ref.board.boardKey}/${ref.threadKey}`;
    persist();
    try {
      const posts = await adapter.fetchThreadPosts(ref);
      threadsFetched += 1;
      const saved = saveThread(adapter, boardId, ref, posts);
      mediaFound += saved.found;
      mediaNew += saved.added;
    } catch (error) {
      errors += 1;
      logEvent('error', `thread failed ${currentThread}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Failed HTTP requests count too; hot limits must not accidentally allow unlimited failures.
      threadsAttempted += 1;
      currentThread = null;
      persist();
    }
  };

  try {
    if (target) {
      boardsChecked = 1;
      persist();
      if (!cancelled()) {
        const snapshot = await target.adapter.listBoardThreads(target.board);
        const unique = new Map<string, SourceThreadRef>();
        for (const ref of snapshot) {
          if (!unique.has(ref.threadKey)) unique.set(ref.threadKey, { ...ref, board: target.board });
        }
        threadsTotal = unique.size;
        threadsSeen = threadsTotal;
        persist();
        logEvent('info', `current board snapshot: ${threadsTotal} unique threads`);
        for (const ref of unique.values()) {
          if (cancelled()) break;
          await attempt(target.adapter, target.row.id, ref);
        }
      }
    } else {
      for (const adapter of adapters) {
        const collectable = await adapter.listBoards();
        upsertBoards(adapter, collectable, enabledBoardKeys());
        const rows = boardMapByKey(adapter.sourceId);
        const enabled = collectable.filter((board) => rows.get(`${board.server}/${board.boardKey}`)?.enabled === 1 && adapter.isBoardEligible(board));
        boardsChecked += enabled.length;
        logEvent('info', `[${adapter.sourceId}] boards: ${enabled.length}/${collectable.length} enabled`);
        const refs = await adapter.listHotThreads(rotateBoards(enabled));
        threadsSeen += refs.length;
        const eligible = refs.filter((ref) => rows.get(`${ref.board.server}/${ref.board.boardKey}`)?.enabled === 1);
        const selected = eligible.slice(0, config.collect.maxDatPerJob);
        threadsTotal += selected.length;
        persist();
        for (const ref of selected) {
          const row = rows.get(`${ref.board.server}/${ref.board.boardKey}`)!;
          await attempt(adapter, row.id, ref);
        }
      }
    }
    const message = `boards=${boardsChecked} threads=${threadsSeen} attempted=${threadsAttempted}/${threadsTotal} fetched=${threadsFetched} media=${mediaFound} new=${mediaNew} errors=${errors}`;
    const status: FinishedStatus = cancelled() ? 'cancelled' : errors > 0 ? (threadsFetched > 0 ? 'partial' : 'error') : 'success';
    logEvent('info', `${status}: ${message}`);
    setSetting('last_collect_at', String(Math.floor(Date.now() / 1000)));
    return finalize(status, message);
  } catch (error) {
    errors += 1;
    const message = error instanceof Error ? error.message : String(error);
    logEvent('error', `job failed: ${message}`);
    return finalize(cancelled() ? 'cancelled' : threadsFetched > 0 ? 'partial' : 'error', message);
  } finally {
    running = false;
  }
}
