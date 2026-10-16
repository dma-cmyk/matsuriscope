import { defineStore } from 'pinia';
import { api, type Board, type MediaItem, type Stats } from './api';

export type TypeFilter = 'all' | 'image' | 'video' | 'gif' | 'favorite';
export type SortKey = 'ikioi' | 'new' | 'res' | 'buzz';
export type PeriodKey = '' | '24h' | '3d' | '7d';

interface MediaState {
  items: MediaItem[];
  total: number;
  page: number;
  limit: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  requestSeq: number; // リクエスト世代番号 (競合解決用)
  // フィルタ状態
  typeFilter: TypeFilter;
  sort: SortKey;
  period: PeriodKey;
  board: string;
  keyword: string;
}

export const useMediaStore = defineStore('media', {
  state: (): MediaState => ({
    items: [],
    total: 0,
    page: 1,
    limit: 30,
    loading: false,
    loadingMore: false,
    error: null,
    requestSeq: 0,
    typeFilter: 'all',
    sort: 'ikioi',
    period: '',
    board: '',
    keyword: '',
  }),
  getters: {
    hasMore: (s) => s.items.length < s.total,
  },
  actions: {
    query() {
      return {
        type: this.typeFilter === 'all' ? '' : this.typeFilter,
        sort: this.sort,
        period: this.period,
        board: this.board,
        q: this.keyword,
      };
    },
    async refresh() {
      // 世代番号: 絞り込み連打で遅れて返った古い応答を破棄する
      const seq = ++this.requestSeq;
      this.loading = true;
      this.error = null;
      try {
        const res = await api.media({ ...this.query(), page: 1, limit: this.limit });
        if (seq !== this.requestSeq) return;
        this.items = res.items;
        this.total = res.total;
        this.page = 1;
      } catch (e) {
        if (seq !== this.requestSeq) return;
        this.error = (e as Error).message;
      } finally {
        if (seq === this.requestSeq) this.loading = false;
      }
    },
    async loadMore() {
      if (this.loadingMore || this.loading || !this.hasMore) return;
      const seq = this.requestSeq; // refreshが走ったら結果を捨てる
      this.loadingMore = true;
      try {
        const res = await api.media({ ...this.query(), page: this.page + 1, limit: this.limit });
        if (seq !== this.requestSeq) return;
        const existing = new Set(this.items.map((m) => m.id));
        this.items.push(...res.items.filter((m) => !existing.has(m.id)));
        this.page = res.page;
        this.total = res.total;
      } catch (e) {
        if (seq !== this.requestSeq) return;
        this.error = (e as Error).message;
      } finally {
        if (seq === this.requestSeq) this.loadingMore = false;
      }
    },
    setFilter(patch: Partial<Pick<MediaState, 'typeFilter' | 'sort' | 'period' | 'board' | 'keyword'>>) {
      Object.assign(this, patch);
      void this.refresh();
    },
    async toggleFavorite(item: MediaItem) {
      const next = item.favorite !== 1;
      item.favorite = next ? 1 : 0; // 楽観更新
      try {
        await api.setFavorite(item.id, next);
        void useMetaStore().refreshStats();
      } catch {
        item.favorite = next ? 0 : 1; // ロールバック
      }
    },
  },
});

interface AppMetaState {
  stats: Stats | null;
  boards: Board[];
  collecting: boolean;
}

export const useMetaStore = defineStore('meta', {
  state: (): AppMetaState => ({ stats: null, boards: [], collecting: false }),
  actions: {
    async refreshStats() {
      this.stats = await api.stats();
    },
    async refreshBoards() {
      this.boards = (await api.boards()).items;
    },
    async triggerCollect() {
      this.collecting = true;
      try {
        await api.collect();
      } finally {
        this.collecting = false;
      }
    },
  },
});
