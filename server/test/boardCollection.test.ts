import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import express from 'express';
import { once } from 'node:events';
import type { SourceAdapter, SourceBoard, SourcePost, SourceThreadRef } from '../src/adapters/types.js';

const fake = vi.hoisted(() => ({
  sourceId: 'fake',
  listBoards: vi.fn<SourceAdapter['listBoards']>(),
  isBoardEligible: vi.fn<SourceAdapter['isBoardEligible']>(),
  listBoardThreads: vi.fn<SourceAdapter['listBoardThreads']>(),
  listHotThreads: vi.fn<SourceAdapter['listHotThreads']>(),
  fetchThreadPosts: vi.fn<SourceAdapter['fetchThreadPosts']>(),
  threadUrl: vi.fn<SourceAdapter['threadUrl']>(),
  extractMedia: vi.fn<SourceAdapter['extractMedia']>(),
}));
vi.mock('../src/adapters/index.js', () => ({ adapters: [fake] }));
vi.mock('../src/config.js', () => ({ config: {
  dbFile: ':memory:',
  collect: { maxBoardsPerJob: 1, maxThreadsPerBoard: 1, maxDatPerJob: 2, intervalMinutes: 30, requestDelayMs: 500 },
} }));

import { db, initializeDatabase, setSetting } from '../src/db.js';
import {
  isCollectRunning, refreshBoards, requestBoardCancellation, runCollect, startBoardCollect,
} from '../src/collector/collect.js';
import { api } from '../src/routes/index.js';

const board: SourceBoard = { server: 'test', boardKey: 'board', name: 'Test board', category: 'test', url: 'https://test.invalid/board/' };
const posts: SourcePost[] = [{ resNo: 1, name: '', dateText: '', bodyText: 'image', rawBodyHtml: 'image' }];
let boardId: number;

beforeEach(() => {
  vi.resetAllMocks();
  db.exec('DELETE FROM job_events; DELETE FROM collect_jobs; DELETE FROM media_occurrences; DELETE FROM media; DELETE FROM threads; DELETE FROM boards; DELETE FROM settings;');
  boardId = Number(db.prepare('INSERT INTO boards(source_id, server, board_key, name, category, url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(fake.sourceId, board.server, board.boardKey, board.name, board.category, board.url).lastInsertRowid);
  fake.isBoardEligible.mockReturnValue(true);
  fake.listBoards.mockResolvedValue([board]);
  const refs: SourceThreadRef[] = Array.from({ length: 6 }, (_, index) => ({ board, threadKey: String(1700000000 + index), title: `Thread ${index}`, resCount: index }));
  fake.listBoardThreads.mockResolvedValue([...refs, refs[0]!]);
  fake.listHotThreads.mockResolvedValue(refs);
  fake.fetchThreadPosts.mockResolvedValue(posts);
  fake.threadUrl.mockImplementation((ref) => `${ref.board.url}${ref.threadKey}`);
  fake.extractMedia.mockReturnValue([{ type: 'image', url: 'https://media.invalid/shared.jpg', canonicalUrl: 'https://media.invalid/shared.jpg', thumbnailUrl: null, previewable: true, resNo: 1 }]);
});

afterAll(() => db.close());

describe('complete current board collection', () => {
  it('attempts every unique low-res thread beyond hot caps, commits deduped occurrences, and publishes durable progress', async () => {
    let attempts = 0;
    fake.fetchThreadPosts.mockImplementation(async (ref) => {
      const job = db.prepare('SELECT * FROM collect_jobs ORDER BY id DESC LIMIT 1').get();
      expect(job).toMatchObject({ status: 'running', threads_total: 6, threads_attempted: attempts, current_thread: `test/board/${ref.threadKey}` });
      attempts += 1;
      return posts;
    });
    const started = startBoardCollect(boardId);
    expect(db.prepare('SELECT id, scope, board_id, status FROM collect_jobs WHERE id = ?').get(started.jobId))
      .toMatchObject({ id: started.jobId, scope: 'board', board_id: boardId, status: 'running' });
    expect(await started.completion).toMatchObject({ status: 'success', threadsSeen: 6, threadsAttempted: 6, threadsFetched: 6, mediaFound: 6, mediaNew: 1 });
    expect(fake.listBoardThreads).toHaveBeenCalledTimes(1);
    expect(fake.listBoards).not.toHaveBeenCalled();
    expect(fake.listHotThreads).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM media').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_occurrences').get()).toMatchObject({ count: 6 });
    expect(db.prepare('SELECT occ_count FROM media').get()).toMatchObject({ occ_count: 6 });
    db.prepare('UPDATE media SET favorite = 1').run();
    const repeated = startBoardCollect(boardId);
    // Reset callback progress expectations for a second complete snapshot.
    attempts = 0;
    expect(await repeated.completion).toMatchObject({ status: 'success', mediaNew: 0 });
    expect(db.prepare('SELECT favorite, occ_count FROM media').get()).toMatchObject({ favorite: 1, occ_count: 6 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_occurrences').get()).toMatchObject({ count: 6 });
  });

  it('counts failed requests as attempts, persists each result, and reports partial instead of success', async () => {
    let attempted = 0;
    fake.fetchThreadPosts.mockImplementation(async () => {
      const job = db.prepare('SELECT threads_attempted, errors FROM collect_jobs ORDER BY id DESC LIMIT 1').get();
      expect(job).toMatchObject({ threads_attempted: attempted, errors: attempted >= 2 ? 1 : 0 });
      attempted += 1;
      if (attempted === 2) throw new Error('HTTP 503');
      return posts;
    });
    const { jobId, completion } = startBoardCollect(boardId);
    expect(await completion).toMatchObject({ status: 'partial', threadsAttempted: 6, threadsFetched: 5, errors: 1 });
    expect(db.prepare('SELECT * FROM collect_jobs WHERE id = ?').get(jobId))
      .toMatchObject({ status: 'partial', threads_total: 6, threads_attempted: 6, threads_fetched: 5, errors: 1, current_thread: null });
    expect(db.prepare('SELECT message FROM job_events WHERE job_id = ? AND level = ?').get(jobId, 'error'))
      .toMatchObject({ message: expect.stringContaining('HTTP 503') });
  });

  it('rolls back a failed per-thread media save without leaking media counters or occurrences', async () => {
    fake.fetchThreadPosts.mockResolvedValueOnce([posts[0]!, { ...posts[0]!, resNo: 2 }]);
    fake.extractMedia.mockReturnValueOnce([{
      type: 'image', url: 'https://media.invalid/rolled-back.jpg', canonicalUrl: 'https://media.invalid/rolled-back.jpg',
      thumbnailUrl: null, previewable: true, resNo: 1,
    }]).mockImplementationOnce(() => {
      throw new Error('extraction failed after first post was saved');
    });
    const { completion } = startBoardCollect(boardId);
    expect(await completion).toMatchObject({ status: 'partial', threadsAttempted: 6, threadsFetched: 6, mediaFound: 5, mediaNew: 1, errors: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toMatchObject({ count: 5 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_occurrences').get()).toMatchObject({ count: 5 });
    expect(db.prepare('SELECT url_canonical FROM media').all()).toEqual([
      expect.objectContaining({ url_canonical: 'https://media.invalid/shared.jpg' }),
    ]);
  });

  it('shares exclusion with hot jobs and waits for the in-flight request before honouring cancellation', async () => {
    const entered = Promise.withResolvers<void>();
    const inFlight = Promise.withResolvers<SourcePost[]>();
    fake.fetchThreadPosts.mockImplementationOnce(() => {
      entered.resolve();
      return inFlight.promise;
    });
    const { jobId, completion } = startBoardCollect(boardId);
    await entered.promise;
    expect(isCollectRunning()).toBe(true);
    expect(await runCollect('schedule')).toBeNull();
    expect(() => startBoardCollect(boardId)).toThrow('already running');
    requestBoardCancellation(jobId);
    expect(db.prepare('SELECT status, cancel_requested, threads_attempted FROM collect_jobs WHERE id = ?').get(jobId))
      .toMatchObject({ status: 'running', cancel_requested: 1, threads_attempted: 0 });
    expect(isCollectRunning()).toBe(true);
    inFlight.resolve(posts);
    expect(await completion).toMatchObject({ status: 'cancelled', threadsAttempted: 1, threadsFetched: 1 });
    expect(fake.fetchThreadPosts).toHaveBeenCalledTimes(1);
    expect(isCollectRunning()).toBe(false);
    expect(() => requestBoardCancellation(jobId)).toThrow('only running board jobs');
    const hot = await runCollect('manual');
    expect(hot).toMatchObject({ status: 'success', threadsAttempted: 2 });
  });

  it('excludes board starts while a hot job is active and applies hot caps to failed requests too', async () => {
    const entered = Promise.withResolvers<void>();
    const discovery = Promise.withResolvers<SourceThreadRef[]>();
    fake.listHotThreads.mockImplementationOnce(() => {
      entered.resolve();
      return discovery.promise;
    });
    const hot = runCollect('startup');
    await entered.promise;
    expect(() => startBoardCollect(boardId)).toThrow('already running');
    fake.fetchThreadPosts.mockRejectedValue(new Error('HTTP 403'));
    discovery.resolve(Array.from({ length: 6 }, (_, index) => ({ board, threadKey: String(1700000000 + index), title: 'hot', resCount: 50 })));
    expect(await hot).toMatchObject({ status: 'error', threadsAttempted: 2, threadsFetched: 0, errors: 2 });
    expect(fake.fetchThreadPosts).toHaveBeenCalledTimes(2);
  });

  it('can cancel while the one subject snapshot is in flight without starting a thread', async () => {
    const entered = Promise.withResolvers<void>();
    const snapshot = Promise.withResolvers<SourceThreadRef[]>();
    fake.listBoardThreads.mockImplementationOnce(() => {
      entered.resolve();
      return snapshot.promise;
    });
    const { jobId, completion } = startBoardCollect(boardId);
    await entered.promise;
    requestBoardCancellation(jobId);
    snapshot.resolve([{ board, threadKey: '1700000000', title: 'still current', resCount: 1 }]);
    expect(await completion).toMatchObject({ status: 'cancelled', threadsSeen: 1, threadsAttempted: 0 });
    expect(fake.fetchThreadPosts).not.toHaveBeenCalled();
  });

  it('ends failed snapshot discovery honestly and releases the lock', async () => {
    fake.listBoardThreads.mockRejectedValueOnce(new Error('subject timeout'));
    const { jobId, completion } = startBoardCollect(boardId);
    expect(await completion).toMatchObject({ status: 'error', threadsAttempted: 0, errors: 1 });
    expect(db.prepare('SELECT status, finished_at FROM collect_jobs WHERE id = ?').get(jobId))
      .toMatchObject({ status: 'error', finished_at: expect.any(Number) });
    expect(isCollectRunning()).toBe(false);
  });

  it('rejects invalid, missing, disabled, disallowed source and ineligible board identities before allocation', () => {
    expect(() => startBoardCollect(0)).toThrow('positive integer');
    expect(() => startBoardCollect(1.5)).toThrow('positive integer');
    expect(() => startBoardCollect(999999)).toThrow('not found');
    db.prepare('UPDATE boards SET enabled = 0 WHERE id = ?').run(boardId);
    expect(() => startBoardCollect(boardId)).toThrow('not eligible');
    db.prepare('UPDATE boards SET enabled = 1, source_id = ? WHERE id = ?').run('unknown', boardId);
    expect(() => startBoardCollect(boardId)).toThrow('not eligible');
    db.prepare('UPDATE boards SET source_id = ? WHERE id = ?').run(fake.sourceId, boardId);
    fake.isBoardEligible.mockReturnValue(false);
    expect(() => startBoardCollect(boardId)).toThrow('not eligible');
    fake.isBoardEligible.mockReturnValue(true);
    setSetting('boards_enabled_json', '[]');
    expect(() => startBoardCollect(boardId)).toThrow('not eligible');
    expect(db.prepare('SELECT COUNT(*) AS count FROM collect_jobs').get()).toMatchObject({ count: 0 });
  });

  it('refreshes menus on an empty DB without media collection and respects settings/exclusions', async () => {
    db.exec('DELETE FROM boards');
    const excluded = { ...board, boardKey: 'excluded', category: 'excluded' };
    fake.isBoardEligible.mockImplementation((candidate) => candidate.category !== 'excluded');
    fake.listBoards.mockResolvedValue([board, excluded]);
    setSetting('boards_enabled_json', '[]');
    await refreshBoards();
    expect(db.prepare('SELECT board_key, enabled FROM boards').all()).toEqual([expect.objectContaining({ board_key: 'board', enabled: 0 })]);
    setSetting('boards_enabled_json', '["test/board"]');
    await refreshBoards();
    expect(db.prepare('SELECT enabled FROM boards').get()).toMatchObject({ enabled: 1 });
    expect(fake.listBoardThreads).not.toHaveBeenCalled();
    expect(fake.listHotThreads).not.toHaveBeenCalled();
    expect(fake.fetchThreadPosts).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM collect_jobs').get()).toMatchObject({ count: 0 });
  });
});

describe('legacy database migration', () => {
  it('preserves jobs, event IDs/links, favorites, sequence and foreign keys; interrupts stale running jobs', () => {
    const legacy = new DatabaseSync(':memory:');
    try {
      const schema = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
      const oldJobs = `CREATE TABLE IF NOT EXISTS collect_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()), finished_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running','success','error')),
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule','manual','startup')),
        boards_checked INTEGER NOT NULL DEFAULT 0, threads_seen INTEGER NOT NULL DEFAULT 0,
        threads_fetched INTEGER NOT NULL DEFAULT 0, media_found INTEGER NOT NULL DEFAULT 0,
        media_new INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, message TEXT
      );`;
      legacy.exec(schema.replace(/CREATE TABLE IF NOT EXISTS collect_jobs \([\s\S]*?\n\);/, oldJobs));
      legacy.exec(`
        INSERT INTO collect_jobs(id, started_at, finished_at, status, trigger_type, threads_seen, threads_fetched, message)
          VALUES (41, 100, 200, 'success', 'manual', 7, 3, 'kept'), (42, 300, NULL, 'running', 'schedule', 9, 4, NULL);
        INSERT INTO job_events(id, job_id, ts, level, message) VALUES (71, 41, 150, 'info', 'saved event'), (72, 42, 350, 'warn', 'running event');
        INSERT INTO collect_jobs(id, status, trigger_type) VALUES (100, 'success', 'manual');
        DELETE FROM collect_jobs WHERE id = 100;
        INSERT INTO media(id, url_canonical, type, url, favorite) VALUES (81, 'https://media.invalid/kept.jpg', 'image', 'https://media.invalid/kept.jpg', 1);
      `);
      initializeDatabase(legacy);
      expect(legacy.prepare('SELECT * FROM collect_jobs WHERE id = 41').get()).toMatchObject({ id: 41, started_at: 100, finished_at: 200, status: 'success', scope: 'hot', board_id: null, threads_total: 7, threads_attempted: 3, message: 'kept' });
      expect(legacy.prepare('SELECT * FROM collect_jobs WHERE id = 42').get()).toMatchObject({ id: 42, status: 'interrupted', threads_attempted: 4, finished_at: expect.any(Number) });
      expect(legacy.prepare('SELECT id, job_id, ts, message FROM job_events ORDER BY id').all()).toEqual([
        expect.objectContaining({ id: 71, job_id: 41, ts: 150, message: 'saved event' }),
        expect.objectContaining({ id: 72, job_id: 42, ts: 350, message: 'running event' }),
      ]);
      expect(legacy.prepare('SELECT id, favorite FROM media').get()).toMatchObject({ id: 81, favorite: 1 });
      const next = legacy.prepare("INSERT INTO collect_jobs(status, trigger_type, scope) VALUES ('partial', 'manual', 'board')").run();
      expect(Number(next.lastInsertRowid)).toBeGreaterThan(100);
      expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(legacy.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
      legacy.prepare('DELETE FROM collect_jobs WHERE id = 41').run();
      expect(legacy.prepare('SELECT id FROM job_events WHERE id = 71').get()).toBeUndefined();
      initializeDatabase(legacy);
      expect(legacy.prepare('SELECT status FROM collect_jobs WHERE id = 42').get()).toMatchObject({ status: 'interrupted' });
    } finally {
      legacy.close();
    }
  });
});

describe('board job HTTP contract without scheduler or external requests', () => {
  it('refreshes an empty DB, allocates real IDs, exposes enriched progress, and defers cancellation completion', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', api);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener address');
    const base = `http://127.0.0.1:${address.port}/api`;
    const entered = Promise.withResolvers<void>();
    const inFlight = Promise.withResolvers<SourcePost[]>();
    try {
      db.exec('DELETE FROM boards');
      const refreshed = await fetch(`${base}/boards/refresh`, { method: 'POST' });
      expect(refreshed.status).toBe(200);
      const menu = await refreshed.json();
      expect(menu.items).toEqual([expect.objectContaining({ server: 'test', board_key: 'board', enabled: 1 })]);
      const selectedId = menu.items[0].id;
      expect(fake.listBoardThreads).not.toHaveBeenCalled();
      for (const value of [0, 1.5, '1', null]) {
        const invalid = await fetch(`${base}/collect/board`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boardId: value }) });
        expect(invalid.status).toBe(400);
      }
      const missing = await fetch(`${base}/collect/board`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boardId: 999999 }) });
      expect(missing.status).toBe(404);
      fake.fetchThreadPosts.mockImplementationOnce(() => {
        entered.resolve();
        return inFlight.promise;
      });
      const response = await fetch(`${base}/collect/board`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boardId: selectedId, url: 'https://ignored.invalid/' }) });
      expect(response.status).toBe(202);
      const started = await response.json();
      expect(started).toEqual({ started: true, jobId: expect.any(Number) });
      await entered.promise;
      const progress = await fetch(`${base}/jobs/${started.jobId}`).then((result) => result.json());
      expect(progress).toMatchObject({ job: { id: started.jobId, scope: 'board', board_id: selectedId, board_name: 'Test board', board_key: 'test/board', status: 'running', threads_total: 6, threads_attempted: 0, cancel_requested: 0, current_thread: 'test/board/1700000000' }, events: expect.any(Array) });
      const busy = await fetch(`${base}/collect`, { method: 'POST' });
      expect(busy.status).toBe(409);
      const cancelled = await fetch(`${base}/jobs/${started.jobId}/cancel`, { method: 'POST' });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ cancelRequested: true });
      const pending = await fetch(`${base}/jobs/${started.jobId}`).then((result) => result.json());
      expect(pending.job).toMatchObject({ status: 'running', cancel_requested: 1, finished_at: null });
      inFlight.resolve(posts);
      const finished = await fetch(`${base}/jobs/${started.jobId}`).then((result) => result.json());
      expect(finished.job).toMatchObject({ status: 'cancelled', threads_attempted: 1, threads_fetched: 1, media_found: 1, current_thread: null, finished_at: expect.any(Number) });
      expect(fake.fetchThreadPosts).toHaveBeenCalledTimes(1);
      const stopped = await fetch(`${base}/jobs/${started.jobId}/cancel`, { method: 'POST' });
      expect(stopped.status).toBe(409);
      expect((await fetch(`${base}/jobs/999999`)).status).toBe(404);
      expect((await fetch(`${base}/jobs/999999/cancel`, { method: 'POST' })).status).toBe(404);
      const listed = await fetch(`${base}/jobs`).then((result) => result.json());
      expect(listed.jobs[0]).toMatchObject({ id: started.jobId, board_key: 'test/board', threads_attempted: 1 });
      expect(listed.events).toEqual(expect.any(Array));
      const media = await fetch(`${base}/media?board=test%2Fboard`).then((result) => result.json());
      expect(media.total).toBe(1);
      const twitter = await fetch(`${base}/media?type=twitter`).then((result) => result.json());
      expect(twitter.total).toBe(0);
    } finally {
      inFlight.resolve(posts);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
