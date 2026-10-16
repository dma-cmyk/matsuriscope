import type { ExtractedMedia, MediaType, SourcePost } from '../types.js';
import { decodeEntities } from './dat.js';

/**
 * 投稿本文からのメディアURL抽出・分類・正規化。
 * 純粋関数: ネットワークアクセスなし。
 */

const RAW_URL_RE = /https?:\/\/[^\s<>"'』」）〕【】、。！？]+/gi;
const HREF_URL_RE = /href="(https?:\/\/[^"]+)"/gi;

const IMAGE_EXT: Record<string, true> = { jpg: true, jpeg: true, png: true, webp: true, avif: true };
const GIF_EXT: Record<string, true> = { gif: true };
const VIDEO_EXT: Record<string, true> = { mp4: true, webm: true, mov: true, m4v: true };

/** スレ自体のアイコン・バナー等を除外するホスト (取得したいのは投稿メディアのみ) */
const IGNORED_HOST_SUFFIXES = ['.5ch.io', '.5ch.net', '.2ch.net', '.bbspink.com'];

/** 投稿文中URLの末尾に混入しがちな記号を除去 */
function trimUrlTail(u: string): string {
  return u.replace(/[.,;:!?)\]}'"]+$/, '');
}

function extOf(pathname: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(pathname);
  return m ? m[1]!.toLowerCase() : '';
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|si$|feature$)/i;

function stripTrackingParams(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
}

const YOUTUBE_HOSTS: Record<string, true> = {
  'youtube.com': true,
  'm.youtube.com': true,
  'music.youtube.com': true,
  'www.youtube.com': true,
  'youtu.be': true,
};

function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? '';
    return /^[\w-]{6,20}$/.test(id) ? id : null;
  }
  if (YOUTUBE_HOSTS[host]) {
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      return v && /^[\w-]{6,20}$/.test(v) ? v : null;
    }
    const m = /^\/(shorts|embed|live)\/([\w-]{6,20})/.exec(url.pathname);
    if (m) return m[2]!;
  }
  return null;
}

const TWITTER_HOSTS: Record<string, true> = {
  'twitter.com': true,
  'www.twitter.com': true,
  'x.com': true,
  'www.x.com': true,
  'mobile.twitter.com': true,
  'mobile.x.com': true,
};

function twitterStatus(url: URL): { user: string; id: string } | null {
  const host = url.hostname.toLowerCase();
  if (!TWITTER_HOSTS[host]) return null;
  const m = /^\/([\w]+)\/status(?:es)?\/(\d+)/.exec(url.pathname);
  if (!m) return null;
  return { user: m[1]!, id: m[2]! };
}

function classify(url: URL): { type: MediaType; previewable: boolean } | null {
  const host = url.hostname.toLowerCase();

  const yt = youtubeId(url);
  if (yt) return { type: 'youtube', previewable: true };

  const tw = twitterStatus(url);
  if (tw) return { type: 'twitter', previewable: false };

  // Twitter メディア直リンク
  if (host === 'video.twimg.com') return { type: 'video', previewable: true };
  if (host === 'pbs.twimg.com') return { type: 'image', previewable: true };

  // imgur 裸リンク (拡張子なし): プレビュー不可のリンクカード扱い
  if (host === 'imgur.com' || host === 'www.imgur.com' || host === 'm.imgur.com') {
    if (IMAGE_EXT[extOf(url.pathname)] || GIF_EXT[extOf(url.pathname)]) {
      return { type: GIF_EXT[extOf(url.pathname)] ? 'gif' : 'image', previewable: true };
    }
    return { type: 'other', previewable: false };
  }

  const ext = extOf(url.pathname);
  if (GIF_EXT[ext]) return { type: 'gif', previewable: true };
  if (IMAGE_EXT[ext]) return { type: 'image', previewable: true };
  if (VIDEO_EXT[ext]) return { type: 'video', previewable: true };

  return null;
}

/** 重複排除用の正規化URLを生成 */
export function canonicalize(url: URL, type: MediaType): string {
  const u = new URL(url.href);
  u.protocol = 'https:';
  u.hash = '';
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  u.hostname = host;

  if (type === 'youtube') {
    const id = youtubeId(u);
    if (id) return `https://youtu.be/${id}`;
  }
  if (type === 'twitter') {
    const st = twitterStatus(u);
    if (st) return `https://x.com/${st.user.toLowerCase()}/status/${st.id}`;
  }
  stripTrackingParams(u);
  // パス末尾スラッシュ正規化
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.href;
}

function thumbnailFor(url: URL, type: MediaType): string | null {
  if (type === 'youtube') {
    const id = youtubeId(url);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  }
  if (type === 'image' || type === 'gif') return url.href;
  return null;
}

export function extractMediaFromPost(post: SourcePost): ExtractedMedia[] {
  // 生HTMLのまま扱うと &amp; 等でURLが壊れるため先にデコードする
  const body = decodeEntities(post.rawBodyHtml);
  const candidates = new Set<string>();
  for (const m of body.matchAll(HREF_URL_RE)) {
    candidates.add(trimUrlTail(m[1]!));
  }
  for (const m of body.matchAll(RAW_URL_RE)) {
    candidates.add(trimUrlTail(m[0]));
  }

  const out: ExtractedMedia[] = [];
  const seenCanonical = new Set<string>();

  for (const raw of candidates) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const host = url.hostname.toLowerCase();
    if (IGNORED_HOST_SUFFIXES.some((s) => host.endsWith(s))) continue;

    const cls = classify(url);
    if (!cls) continue;

    const canonical = canonicalize(url, cls.type);
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);

    out.push({
      type: cls.type,
      url: url.href,
      canonicalUrl: canonical,
      thumbnailUrl: thumbnailFor(url, cls.type),
      previewable: cls.previewable,
      resNo: post.resNo,
    });
  }
  return out;
}
