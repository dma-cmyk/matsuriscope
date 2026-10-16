import { db, type BoardRow, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { adapters } from '../adapters/index.js';
import type { SourceAdapter, SourceBoard } from '../adapters/types.js';
import { calcIkioi } from '../score.js';

/**
 * 収集ジョブ:
 *   1. 板一覧を更新 (アダプタ経由)
 *   2. 注目スレッドを発見 (headline + subject.txt、板はジョブごとにローテーション)
 *   3. datを取得してメディア抽出
 *   4. トランザクションで重複排除してDB保存
 *
 * 収集元の知識は SourceAdapter に閉じ込め、コアは adapters レジストリ経由でのみ呼び出す。
 */

interface RunResult {
  lastInsertRowid: number | bigint;
}

interface IdRow {
  id: number | bigint;
}

interface MediaInsertRow extends IdRow {
  occ_threads: number | bigint;
}

let running = false; // 多重起動防止 (プロセス内排他)

export function isCollectRunning(): boolean {
  return running;
}

function upsertBoards(adapter: SourceAdapter, boards: SourceBoard[], enabledKeys: Set<string> | null): void {
  const stmt = db.prepare(`
    INSERT INTO boards(source_id, server, board_key, name, category, url, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, server, board_key) DO UPDATE SET
      name = excluded.name, category = excluded.category, url = excluded.url, enabled = excluded.enabled
  `);
  for (const b of boards) {
    const enabled = enabledKeys === null ? 1 : enabledKeys.has(`${b.server}/${b.boardKey}`) ? 1 : 0;
    stmt.run(adapter.sourceId, b.server, b.boardKey, b.name, b.category, b.url, enabled);
  }
}

function boardMapByKey(sourceId: string): Map<string, BoardRow> {
  const rows = db.prepare('SELECT * FROM boards WHERE source_id = ?').all(sourceId) as unknown as BoardRow[];
  const map = new Map<string, BoardRow>();
  for (const r of rows) map.set(`${r.server}/${r.board_key}`, r);
  return map;
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
  RETURNING id, (SELECT COUNT(DISTINCT thread_id) FROM media_occurrences WHERE media_id = media.id) AS occ_threads
`);

const insOcc = db.prepare(`
  INSERT INTO media_occurrences(media_id, thread_id, res_no, found_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT(media_id, thread_id, res_no) DO NOTHING
`);

const updOccCount = db.prepare(
  'UPDATE media SET occ_count = (SELECT COUNT(DISTINCT thread_id) FROM media_occurrences WHERE media_id = ?) WHERE id = ?',
);

/** ジョブごとに巡回する板の開始位置をローテーション (全板に公平に回す) */
function rotateBoards(boards: SourceBoard[]): SourceBoard[] {
  const max = config.collect.maxBoardsPerJob;
  if (boards.length <= max) return boards;
  const offset = Number(getSetting('board_rotation_offset') ?? '0') || 0;
  const start = offset % boards.length;
  setSetting('board_rotation_offset', String(start + max));
  const rotated = boards.slice(start, start + max);
  // 端を超えた分を先頭から補充
  if (rotated.length < max) rotated.push(...boards.slice(0, max - rotated.length));
  return rotated;
}

export interface CollectResult {
  jobId: number;
  status: 'success' | 'error';
  boardsChecked: number;
  threadsSeen: number;
  threadsFetched: number;
  mediaFound: number;
  mediaNew: number;
  errors: number;
  message: string | null;
}

export async function runCollect(trigger: 'schedule' | 'manual' | 'startup'): Promise<CollectResult | null> {
  if (running) return null; // 既に実行中
  running = true;

  // node:sqlite の run() は { changes, lastInsertRowid } を返す (ライブラリ公称型)
  const runRes = db
    .prepare('INSERT INTO collect_jobs(status, trigger_type) VALUES (?, ?)')
    .run('running', trigger) as unknown as RunResult;
  const jobId = Number(runRes.lastInsertRowid);
  const logEvent = (level: 'info' | 'warn' | 'error', message: string) => {
    db.prepare('INSERT INTO job_events(job_id, level, message) VALUES (?, ?, ?)').run(jobId, level, message);
    if (level !== 'info') console[level](`[collect#${jobId}] ${message}`);
  };

  let boardsChecked = 0;
  let threadsSeen = 0;
  let threadsFetched = 0;
  let mediaFound = 0;
  let mediaNew = 0;
  let errors = 0;

  const finalize = (status: 'success' | 'error', message: string): CollectResult => {
    db.prepare(
      'UPDATE collect_jobs SET finished_at = unixepoch(), status = ?, boards_checked = ?, threads_seen = ?, threads_fetched = ?, media_found = ?, media_new = ?, errors = ?, message = ? WHERE id = ?',
    ).run(status, boardsChecked, threadsSeen, threadsFetched, mediaFound, mediaNew, errors, message, jobId);
    return { jobId, status, boardsChecked, threadsSeen, threadsFetched, mediaFound, mediaNew, errors, message };
  };

  try {
    for (const adapter of adapters) {
      // --- 1. 板一覧更新 ---
      const collectable = await adapter.listBoards();

      // 有効板設定 (settings.boards_enabled_json があればそれを使う。なければ全板有効)
      const enabledJson = getSetting('boards_enabled_json');
      const enabledKeys = enabledJson ? new Set<string>(JSON.parse(enabledJson) as string[]) : null;
      upsertBoards(adapter, collectable, enabledKeys);
      const boardRows = boardMapByKey(adapter.sourceId);
      const enabledBoards = collectable.filter((b) => {
        const row = boardRows.get(`${b.server}/${b.boardKey}`);
        return row?.enabled === 1;
      });
      boardsChecked += enabledBoards.length;
      logEvent('info', `[${adapter.sourceId}] boards: ${enabledBoards.length}/${collectable.length} enabled`);

      // --- 2. 注目スレッド発見 (subject巡回はローテーション) ---
      const hotRefs = await adapter.listHotThreads(rotateBoards(enabledBoards));
      threadsSeen += hotRefs.length;

      // --- 3. dat取得 + メディア抽出 (スレッド単位でトランザクション) ---
      const now = Math.floor(Date.now() / 1000);
      let datCount = 0;

      for (const ref of hotRefs) {
        if (datCount >= config.collect.maxDatPerJob) {
          logEvent('info', `dat fetch cap reached (${config.collect.maxDatPerJob})`);
          break;
        }
        const boardRow = boardRows.get(`${ref.board.server}/${ref.board.boardKey}`);
        if (!boardRow) continue;

        let posts;
        try {
          posts = await adapter.fetchThreadPosts(ref);
          datCount += 1;
          threadsFetched += 1;
        } catch (e) {
          errors += 1;
          logEvent('error', `dat fetch failed ${ref.board.boardKey}/${ref.threadKey}: ${(e as Error).message}`);
          continue;
        }

        // ネットワーク取得成功後の書き込みは1スレッド=1トランザクション
        db.exec('BEGIN');
        try {
          const resCount = Math.max(ref.resCount, posts.length);
          const ikioi = calcIkioi(resCount, Number(ref.threadKey), now);
          const threadRow = upThread.get(
            boardRow.id,
            ref.threadKey,
            ref.title,
            adapter.threadUrl(ref),
            resCount,
            ikioi,
            Number(ref.threadKey),
          ) as unknown as IdRow;
          const threadId = Number(threadRow.id);

          for (const post of posts) {
            const mediaItems = adapter.extractMedia(post);
            for (const m of mediaItems) {
              mediaFound += 1;
              const mediaRow = insMedia.get(
                m.canonicalUrl,
                m.type,
                m.url,
                m.thumbnailUrl,
                m.previewable ? 1 : 0,
              ) as unknown as MediaInsertRow;
              const mediaId = Number(mediaRow.id);
              const wasNew = Number(mediaRow.occ_threads) === 0;
              insOcc.run(mediaId, threadId, m.resNo);
              if (wasNew) {
                mediaNew += 1;
              } else {
                // 再登場: occ_count更新
                updOccCount.run(mediaId, mediaId);
              }
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          errors += 1;
          logEvent('error', `thread save failed ${ref.board.boardKey}/${ref.threadKey}: ${(e as Error).message}`);
        }
      }
    }

    const message = `boards=${boardsChecked} threads=${threadsSeen} fetched=${threadsFetched} media=${mediaFound} new=${mediaNew} errors=${errors}`;
    logEvent('info', `done: ${message}`);
    setSetting('last_collect_at', String(Math.floor(Date.now() / 1000)));
    // メディアを1件も処理できずエラーがある場合は error、それ以外は success
    const status = mediaFound === 0 && errors > 0 ? 'error' : 'success';
    return finalize(status, message);
  } catch (e) {
    const msg = (e as Error).message;
    logEvent('error', `job failed: ${msg}`);
    return finalize('error', msg);
  } finally {
    running = false;
  }
}
