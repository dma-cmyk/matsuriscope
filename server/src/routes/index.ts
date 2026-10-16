import { Router, type Request, type Response } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { buzzScore } from '../score.js';
import { isCollectRunning, runCollect } from '../collector/collect.js';
import { config } from '../config.js';

export const api = Router();

/** 期間フィルタの秒数マッピング */
const PERIOD_SECONDS: Record<string, number> = {
  '24h': 24 * 3600,
  '3d': 3 * 86400,
  '7d': 7 * 86400,
};

const VALID_TYPES = new Set(['all', 'image', 'gif', 'video', 'favorite']);
const VALID_SORTS = new Set(['ikioi', 'new', 'res', 'buzz']);

/** GET /api/stats — ホーム上部の統計 */
api.get('/stats', (_req, res) => {
  const count = (sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);
  const lastJob = db
    .prepare('SELECT * FROM collect_jobs ORDER BY id DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  res.json({
    threads: count('SELECT COUNT(*) AS c FROM threads'),
    images: count("SELECT COUNT(*) AS c FROM media WHERE type = 'image' AND hidden = 0"),
    gifs: count("SELECT COUNT(*) AS c FROM media WHERE type = 'gif' AND hidden = 0"),
    videos: count("SELECT COUNT(*) AS c FROM media WHERE type IN ('video','youtube','twitter','other') AND hidden = 0"),
    mediaTotal: count('SELECT COUNT(*) AS c FROM media WHERE hidden = 0'),
    favorites: count('SELECT COUNT(*) AS c FROM media WHERE favorite = 1'),
    boards: count('SELECT COUNT(*) AS c FROM boards WHERE enabled = 1'),
    lastCollectAt: getSetting('last_collect_at'),
    jobRunning: isCollectRunning(),
    collectIntervalMinutes: config.collect.intervalMinutes,
    lastJob: lastJob ?? null,
  });
});

/** GET /api/boards — 板一覧 */
api.get('/boards', (_req, res) => {
  const rows = db
    .prepare('SELECT id, server, board_key, name, category, enabled FROM boards ORDER BY category, name')
    .all();
  res.json({ items: rows });
});

/** メディア一覧クエリ。occ/thread 情報をJOINして勢い等を返す */
interface MediaQuery {
  type: string;
  board: string | null;
  q: string | null;
  period: string | null;
  sort: string;
  page: number;
  limit: number;
}

function parseMediaQuery(req: Request): MediaQuery {
  const q = req.query;
  const rawLimit = Number(q['limit']);
  const rawPage = Number(q['page']);
  return {
    type: VALID_TYPES.has(String(q['type'])) ? String(q['type']) : 'all',
    board: typeof q['board'] === 'string' && q['board'] ? q['board'] : null,
    q: typeof q['q'] === 'string' && q['q'].trim() ? q['q'].trim().slice(0, 100) : null,
    period:
      typeof q['period'] === 'string' && Object.hasOwn(PERIOD_SECONDS, q['period']) ? q['period'] : null,
    sort: VALID_SORTS.has(String(q['sort'])) ? String(q['sort']) : 'ikioi',
    page: Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1,
    limit: Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 30,
  };
}

api.get('/media', (req: Request, res: Response) => {
  const mq = parseMediaQuery(req);
  const where: string[] = ['m.hidden = 0'];
  const params: (string | number)[] = [];

  if (mq.type === 'favorite') {
    where.push('m.favorite = 1');
  } else if (mq.type === 'video') {
    where.push("m.type IN ('video','youtube','twitter','other')");
  } else if (mq.type !== 'all') {
    where.push('m.type = ?');
    params.push(mq.type);
  }
  if (mq.board) {
    where.push("(b.server || '/' || b.board_key) = ?");
    params.push(mq.board);
  }
  if (mq.q) {
    where.push("t.title LIKE ? ESCAPE '\\'");
    params.push(`%${mq.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  if (mq.period) {
    where.push('m.first_seen_at >= unixepoch() - ?');
    params.push(PERIOD_SECONDS[mq.period]!);
  }

  const whereSql = where.join(' AND ');
  const baseFrom = `
    FROM media m
    JOIN media_occurrences o ON o.media_id = m.id
    JOIN threads t ON t.id = o.thread_id
    JOIN boards b ON b.id = t.board_id
  `;

  // メディアごとに「最も勢いのある出典スレッド」を代表として採用
  const grouped = `
    SELECT m.id AS id, m.type AS type, m.url AS url, m.thumbnail_url AS thumbnail_url,
           m.previewable AS previewable, m.favorite AS favorite,
           m.first_seen_at AS first_seen_at, m.occ_count AS occ_count,
           t.title AS thread_title, t.url AS thread_url, t.res_count AS res_count,
           t.ikioi AS ikioi, b.name AS board_name, b.category AS board_category,
           (b.server || '/' || b.board_key) AS board_key,
           MAX(t.ikioi) AS best_ikioi
    ${baseFrom}
    WHERE ${whereSql}
    GROUP BY m.id
  `;

  // 同値時は m.id DESC で安定化。 buzz は SQL 側で計算して全ページを通した正しい順序にする
  // (buzz = 勢い × (1 + 0.25 × ln(出現スレッド数)) と score.ts の定義と一致させること)
  const orderSql =
    mq.sort === 'new'
      ? 'first_seen_at DESC, m.id DESC'
      : mq.sort === 'res'
        ? 'res_count DESC, m.id DESC'
        : mq.sort === 'buzz'
          ? 'best_ikioi * (1 + 0.25 * ln(MAX(m.occ_count, 1))) DESC, m.id DESC'
          : 'best_ikioi DESC, m.id DESC';

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM (SELECT m.id ${baseFrom} WHERE ${whereSql} GROUP BY m.id)`)
    .get(...params) as { c: number };

  const rows = db
    .prepare(`${grouped} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, mq.limit, (mq.page - 1) * mq.limit) as Record<string, unknown>[];

  const items = rows.map((r) => ({
    ...r,
    buzz_score: buzzScore(Number(r['best_ikioi']), Number(r['occ_count'])),
  }));

  res.json({ items, total: Number(totalRow.c), page: mq.page, limit: mq.limit });
});

/** GET /api/media/:id — 詳細 + 出典一覧 */
api.get('/media/:id', (req, res) => {
  const id = Number(req.params['id']);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!media) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const occurrences = db
    .prepare(
      `SELECT o.res_no, o.found_at, t.title AS thread_title, t.url AS thread_url,
              t.res_count, t.ikioi, b.name AS board_name, (b.server || '/' || b.board_key) AS board_key
       FROM media_occurrences o
       JOIN threads t ON t.id = o.thread_id
       JOIN boards b ON b.id = t.board_id
       WHERE o.media_id = ?
       ORDER BY o.found_at DESC`,
    )
    .all(id);
  res.json({ media, occurrences });
});

/** POST /api/media/:id/favorite { favorite: boolean } */
api.post('/media/:id/favorite', (req: Request, res: Response) => {
  const id = Number(req.params['id']);
  const fav = Boolean(req.body?.favorite) ? 1 : 0;
  const result = db.prepare('UPDATE media SET favorite = ? WHERE id = ?').run(fav, id);
  if (Number(result.changes) === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true, favorite: fav === 1 });
});

/** POST /api/media/:id/hide { hidden: boolean } — 非表示・削除管理 */
api.post('/media/:id/hide', (req: Request, res: Response) => {
  const id = Number(req.params['id']);
  const hidden = Boolean(req.body?.hidden) ? 1 : 0;
  const result = db.prepare('UPDATE media SET hidden = ? WHERE id = ?').run(hidden, id);
  if (Number(result.changes) === 0) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true, hidden: hidden === 1 });
});

/** POST /api/collect — 手動収集 */
api.post('/collect', async (_req, res) => {
  if (isCollectRunning()) {
    res.status(409).json({ error: 'already running' });
    return;
  }
  // 即座に受理してバックグラウンド実行
  void runCollect('manual').catch((e) => console.error('[collect]', e));
  res.status(202).json({ started: true });
});

/** GET /api/jobs — 収集ログ */
api.get('/jobs', (req, res) => {
  const rawLimit = Number(req.query['limit']);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 10;
  const jobs = db.prepare('SELECT * FROM collect_jobs ORDER BY id DESC LIMIT ?').all(limit);
  const events = db
    .prepare(
      `SELECT e.* FROM job_events e
       JOIN (SELECT id FROM collect_jobs ORDER BY id DESC LIMIT ?) j ON j.id = e.job_id
       ORDER BY e.id DESC LIMIT 200`,
    )
    .all(limit);
  res.json({ jobs, events });
});

/** GET /api/config / PUT /api/config — 設定 */
api.get('/config', (_req, res) => {
  res.json({
    collectIntervalMinutes: config.collect.intervalMinutes,
    requestDelayMs: config.collect.requestDelayMs,
    maxBoardsPerJob: config.collect.maxBoardsPerJob,
    maxDatPerJob: config.collect.maxDatPerJob,
    boardsEnabledJson: getSetting('boards_enabled_json'),
  });
});

api.put('/config', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (Array.isArray(body['boardsEnabled'])) {
    const keys = (body['boardsEnabled'] as unknown[]).filter((k): k is string => typeof k === 'string');
    setSetting('boards_enabled_json', JSON.stringify(keys));
  }
  res.json({ ok: true });
});
