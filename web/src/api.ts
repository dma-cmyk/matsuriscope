/**
 * APIクライアント + 共有型定義
 */

export interface Stats {
  threads: number;
  images: number;
  gifs: number;
  videos: number;
  mediaTotal: number;
  favorites: number;
  boards: number;
  lastCollectAt: string | null;
  jobRunning: boolean;
  collectIntervalMinutes: number;
  lastJob: CollectionJob | null;
}

export interface Board {
  id: number;
  server: string;
  board_key: string;
  name: string;
  category: string;
  enabled: number;
}

export type CollectStatus = 'running' | 'success' | 'partial' | 'error' | 'cancelled' | 'interrupted';

export interface CollectionJob {
  id: number;
  scope: 'hot' | 'board';
  trigger_type: 'schedule' | 'manual' | 'startup';
  board_id: number | null;
  board_name: string | null;
  board_key: string | null;
  status: CollectStatus;
  threads_total: number;
  threads_attempted: number;
  threads_fetched: number;
  media_found: number;
  media_new: number;
  errors: number;
  cancel_requested: number;
  current_thread: string | null;
  started_at: number;
  finished_at: number | null;
  message: string | null;
}

export interface JobEvent {
  id: number;
  job_id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type MediaType = 'image' | 'gif' | 'video' | 'youtube' | 'twitter' | 'other';

export interface MediaItem {
  id: number;
  type: MediaType;
  url: string;
  thumbnail_url: string | null;
  previewable: number;
  favorite: number;
  first_seen_at: number;
  occ_count: number;
  thread_title: string;
  thread_url: string;
  res_count: number;
  ikioi: number;
  board_name: string;
  board_category: string;
  board_key: string;
  buzz_score: number;
}

export interface MediaListResponse {
  items: MediaItem[];
  total: number;
  page: number;
  limit: number;
}

export interface MediaDetail {
  media: {
    id: number;
    type: MediaType;
    url: string;
    url_canonical: string;
    thumbnail_url: string | null;
    previewable: number;
    favorite: number;
    first_seen_at: number;
    occ_count: number;
  };
  occurrences: {
    res_no: number | null;
    found_at: number;
    thread_title: string;
    thread_url: string;
    res_count: number;
    ikioi: number;
    board_name: string;
    board_key: string;
  }[];
}

export interface MediaQueryParams {
  type?: string;
  board?: string;
  q?: string;
  period?: string;
  sort?: string;
  page?: number;
  limit?: number;
}

export class ApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`API ${status}: ${detail}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body.slice(0, 200));
  }
  return (await res.json()) as T;
}

export const api = {
  stats: () => request<Stats>('/api/stats'),
  boards: () => request<{ items: Board[] }>('/api/boards'),
  refreshBoards: () => request<{ items: Board[] }>('/api/boards/refresh', { method: 'POST' }),
  jobs: (limit = 10) => request<{ jobs: CollectionJob[]; events: JobEvent[] }>(`/api/jobs?limit=${limit}`),
  job: (id: number) => request<{ job: CollectionJob; events: JobEvent[] }>(`/api/jobs/${id}`),
  collectBoard: (boardId: number) => request<{ started: boolean; jobId: number }>('/api/collect/board', {
    method: 'POST',
    body: JSON.stringify({ boardId }),
  }),
  cancelJob: (id: number) => request<{ cancelRequested: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  media: (params: MediaQueryParams) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    }
    return request<MediaListResponse>(`/api/media?${sp}`);
  },
  mediaDetail: (id: number) => request<MediaDetail>(`/api/media/${id}`),
  setFavorite: (id: number, favorite: boolean) =>
    request<{ ok: boolean; favorite: boolean }>(`/api/media/${id}/favorite`, {
      method: 'POST',
      body: JSON.stringify({ favorite }),
    }),
  hide: (id: number, hidden: boolean) =>
    request<{ ok: boolean }>(`/api/media/${id}/hide`, { method: 'POST', body: JSON.stringify({ hidden }) }),
  collect: () => request<{ started: boolean }>('/api/collect', { method: 'POST' }),
};
