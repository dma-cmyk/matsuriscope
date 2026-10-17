import { config } from '../../config.js';
import { fetchText } from '../../httpClient.js';
import type {
  ExtractedMedia,
  SourceAdapter,
  SourceBoard,
  SourcePost,
  SourceThreadRef,
} from '../types.js';
import { DEFAULT_EXCLUDED_CATEGORIES, parseBbsMenu } from './boardList.js';
import { parseSubject } from './subject.js';
import { decodeEntities, parseDat } from './dat.js';
import { extractMediaFromPost } from './media.js';
import { calcIkioi } from '../../score.js';

const BBSMENU_URL = 'https://menu.5ch.io/bbsmenu.json';
const HEADLINE_URL = 'https://headline.5ch.io/ikioi/';
const HEADLINE_LINK_RE =
  /href="https?:\/\/([a-z0-9-]+)\.5ch\.io\/test\/read\.cgi\/([a-zA-Z0-9_]+)\/(\d+)\/"[^>]*>([^<]+)</g;

/**
 * 5chアダプタ。
 * データ取得経路 (全て公開・認証不要・robots.txtで禁止されていないもの):
 *   板一覧:     menu.5ch.io/bbsmenu.json (公式JSON)
 *   注目スレ:   headline.5ch.io/ikioi/   (公式ヘッドライン)
 *   スレ一覧:   {server}.5ch.io/{board}/subject.txt
 *   スレ本文:   {server}.5ch.io/{board}/dat/{key}.dat
 */
export class FiveChAdapter implements SourceAdapter {
  readonly sourceId = 'fivech';

  /** 収集対象の板のみ返す (デフォルト除外カテゴリはアダプタ内で除去) */
  async listBoards(): Promise<SourceBoard[]> {
    const json = await fetchText(BBSMENU_URL, { maxBytes: 4 * 1024 * 1024 });
    return parseBbsMenu(json).filter((b) => this.isBoardEligible(b));
  }

  isBoardEligible(board: SourceBoard): boolean {
    if (DEFAULT_EXCLUDED_CATEGORIES[board.category] === true) return false;
    if (!/^[a-z0-9-]+$/.test(board.server) || !/^[a-zA-Z0-9_]+$/.test(board.boardKey)) return false;
    return (
      board.url === `https://${board.server}.5ch.io/${board.boardKey}/` ||
      board.url === `https://${board.server}.5ch.net/${board.boardKey}/`
    );
  }

  /** 完全な現行subjectスナップショット。過去ログやheadlineは取得しない。 */
  async listBoardThreads(board: SourceBoard): Promise<SourceThreadRef[]> {
    if (!this.isBoardEligible(board)) throw new Error('board is not eligible for fivech collection');
    const text = await fetchText(`${board.url}subject.txt`, {
      maxBytes: config.collect.maxSubjectBytes,
      encoding: 'cp932',
    });
    const refs = new Map<string, SourceThreadRef>();
    for (const entry of parseSubject(text)) {
      if (!refs.has(entry.threadKey)) refs.set(entry.threadKey, { board, ...entry });
    }
    return [...refs.values()];
  }

  /**
   * 注目スレッド発見:
   * 1. headline.5ch.io/ikioi/ から全板の新着・注目スレ参照を取得 (1リクエスト)
   * 2. 有効板の subject.txt を取得して勢い上位スレを選出
   */
  async listHotThreads(boards: SourceBoard[]): Promise<SourceThreadRef[]> {
    const byKey = new Map<string, SourceBoard>();
    for (const b of boards) byKey.set(`${b.server}/${b.boardKey}`, b);

    const refs = new Map<string, SourceThreadRef>();

    // 1. ヘッドライン (全板横断・低負荷)
    try {
      const html = await fetchText(HEADLINE_URL, { maxBytes: 2 * 1024 * 1024 });
      for (const m of html.matchAll(HEADLINE_LINK_RE)) {
        const [, server, boardKey, threadKey, title] = m;
        const board = byKey.get(`${server}/${boardKey}`);
        if (!board) continue;
        refs.set(`${server}/${boardKey}/${threadKey}`, {
          board,
          threadKey: threadKey!,
          title: decodeEntities(title!).trim(),
          resCount: 0,
        });
      }
    } catch (e) {
      // ヘッドライン失敗は致命傷ではない (subject.txt巡回でカバー)
      console.warn('[fivech] headline fetch failed:', (e as Error).message);
    }

    // 2. 板ごとの subject.txt → 勢い上位
    const now = Math.floor(Date.now() / 1000);
    const targetBoards = boards.slice(0, config.collect.maxBoardsPerJob);
    for (const board of targetBoards) {
      let entries;
      try {
        const text = await fetchText(`${board.url}subject.txt`, {
          maxBytes: config.collect.maxSubjectBytes,
          encoding: 'cp932',
        });
        entries = parseSubject(text);
      } catch (e) {
        console.warn(`[fivech] subject.txt failed for ${board.boardKey}:`, (e as Error).message);
        continue;
      }
      const ranked = entries
        .map((en) => ({
          ...en,
          ikioi: calcIkioi(en.resCount, Number(en.threadKey), now),
        }))
        .filter((en) => en.resCount >= 10) // ノイズ除去: ある程度育ったスレのみ
        .sort((a, b) => b.ikioi - a.ikioi)
        .slice(0, config.collect.maxThreadsPerBoard);
      for (const en of ranked) {
        refs.set(`${board.server}/${board.boardKey}/${en.threadKey}`, {
          board,
          threadKey: en.threadKey,
          title: en.title,
          resCount: en.resCount,
        });
      }
    }

    return [...refs.values()];
  }

  async fetchThreadPosts(thread: SourceThreadRef): Promise<SourcePost[]> {
    const url = `${thread.board.url}dat/${thread.threadKey}.dat`;
    const text = await fetchText(url, {
      maxBytes: config.collect.maxDatBytes,
      encoding: 'cp932',
    });
    return parseDat(text);
  }

  threadUrl(thread: SourceThreadRef): string {
    // board.url は https://{server}.5ch.io/{board}/ 形式
    return new URL(`/test/read.cgi/${thread.board.boardKey}/${thread.threadKey}/`, thread.board.url).href;
  }

  extractMedia(post: SourcePost): ExtractedMedia[] {
    return extractMediaFromPost(post);
  }
}

export const fiveChAdapter = new FiveChAdapter();
