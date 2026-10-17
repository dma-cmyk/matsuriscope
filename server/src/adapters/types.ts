/**
 * Source Adapter 方式:
 * 収集元 (5ch, 将来 X/Reddit 等) ごとにこのインターフェースを実装する。
 * 収集コアはアダプタ経由でのみ外部データにアクセスし、
 * フロントエンド・DB層は収集元の詳細を知らない。
 */

export interface SourceBoard {
  server: string; // ホスト部分 (例: "mi")
  boardKey: string; // 板キー (例: "news4vip")
  name: string; // 表示名
  category: string; // カテゴリ名
  url: string; // 板URL
}

export interface SourceThreadRef {
  board: SourceBoard;
  threadKey: string; // dat番号
  title: string;
  resCount: number;
}

export interface SourcePost {
  resNo: number; // 1-based
  name: string;
  dateText: string;
  bodyText: string; // プレーンテキスト化済み本文
  rawBodyHtml: string; // 生HTML (抽出用・信頼しないデータ)
}

export type MediaType = 'image' | 'gif' | 'video' | 'youtube' | 'twitter' | 'other';

export interface ExtractedMedia {
  type: MediaType;
  url: string; // 元URL
  canonicalUrl: string; // 正規化URL (重複排除用)
  thumbnailUrl: string | null;
  previewable: boolean;
  resNo: number;
}

export interface SourceAdapter {
  readonly sourceId: string; // "fivech" 等

  /** 収集対象の板一覧を返す (収集可否の絞り込みはアダプタの責務) */
  listBoards(): Promise<SourceBoard[]>;

  /** DB由来の板も取得前に、収集元のURL・カテゴリ許可規則で検証する。 */
  isBoardEligible(board: SourceBoard): boolean;

  /** 現行一覧を一度だけ取得する。勢い・レス数・hotジョブ上限による切り捨てはしない。 */
  listBoardThreads(board: SourceBoard): Promise<SourceThreadRef[]>;

  /** 注目スレッド参照の一覧 (勢い上位など) を返す */
  listHotThreads(boards: SourceBoard[]): Promise<SourceThreadRef[]>;

  /** スレッド本文を取得 (失敗時は HttpError を投げる) */
  fetchThreadPosts(thread: SourceThreadRef): Promise<SourcePost[]>;

  /** スレッドの閲覧用URLを生成する (URL形式の知識はアダプタに閉じ込める) */
  threadUrl(thread: SourceThreadRef): string;

  /** 投稿本文からメディアを抽出する (純粋関数) */
  extractMedia(post: SourcePost): ExtractedMedia[];
}
