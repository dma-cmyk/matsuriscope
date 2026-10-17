const X_POST_HOSTS: Record<string, true> = {
  'x.com': true,
  'www.x.com': true,
  'mobile.x.com': true,
  'twitter.com': true,
  'www.twitter.com': true,
  'mobile.twitter.com': true,
};

/** Keep IDs as strings: current X snowflakes exceed Number.MAX_SAFE_INTEGER. */
export function xPostId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (X_POST_HOSTS[url.hostname] !== true) return null;
  // Only complete post URLs, with optional official media permalinks. Keep in
  // sync with extraction; x-media.test.ts exercises both trust boundaries.
  const match = /^\/(?:[a-zA-Z0-9_]{1,15}\/status(?:es)?|i\/web\/status)\/([1-9]\d{0,19})(?:\/(?:photo|video)\/[1-4])?\/?$/.exec(url.pathname);
  return match?.[1] ?? null;
}

export function xPostEmbed(rawUrl: string): { src: string; originalUrl: string; embedId: string } | null {
  const id = xPostId(rawUrl);
  if (!id) return null;
  const embedId = `x-post-${id}`;
  const params = new URLSearchParams({ id, lang: 'ja', theme: 'dark', dnt: 'true', embedId, hideThread: 'true' });
  return {
    src: `https://platform.twitter.com/embed/Tweet.html?${params}`,
    originalUrl: `https://x.com/i/web/status/${id}`,
    embedId,
  };
}

/** Accept geometry only, never HTML, navigation, or an availability claim. */
export function xPostResizeHeight(
  event: { origin: string; source: unknown; data: unknown },
  expectedSource: unknown,
  embedId: string,
): number | null {
  if (!expectedSource || event.source !== expectedSource || event.origin !== 'https://platform.twitter.com') return null;
  const message = event.data as { 'twttr.embed'?: { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: unknown } } | null;
  if (!message || typeof message !== 'object') return null;
  const rpc = message['twttr.embed'];
  if (!rpc || rpc.jsonrpc !== '2.0' || rpc.method !== 'twttr.private.resize' || rpc.id !== embedId) return null;
  if (!Array.isArray(rpc.params)) return null;
  const height: unknown = rpc.params[0]?.height;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 100 || height > 10_000) return null;
  return Math.ceil(height) + 2;
}
