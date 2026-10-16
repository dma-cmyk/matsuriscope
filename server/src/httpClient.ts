import { config } from './config.js';

/**
 * 外部取得専用HTTPクライアント。
 * - ホスト許可リスト (SSRF対策)
 * - http/httpsスキームのみ
 * - レート制限 (同一ホストへの最小間隔)
 * - タイムアウト / レスポンスサイズ上限 / リダイレクト回数制限
 */

const ALLOWED_HOST_SUFFIXES = ['.5ch.io', '.5ch.net'];
const ALLOWED_HOSTS_EXACT: Record<string, true> = {
  '5ch.io': true,
  '5ch.net': true,
  'menu.5ch.io': true,
  'headline.5ch.io': true,
};

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function assertAllowedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(`blocked scheme: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const ok =
    ALLOWED_HOSTS_EXACT[host] === true ||
    ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
  if (!ok) throw new HttpError(`host not allowed: ${host}`);
  return url;
}

// グローバルなリクエスト間隔管理 (全ホスト合算のシンプルなレート制限)
let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

async function waitTurn(): Promise<void> {
  const run = chain.then(async () => {
    const wait = lastRequestAt + config.collect.requestDelayMs - Date.now();
    if (wait > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait);
      await promise;
    }
    lastRequestAt = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}

export interface FetchTextOptions {
  maxBytes: number;
  encoding?: 'cp932' | 'utf8';
}

async function readBodyWithLimit(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(`response too large (> ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** CP932デコーダ (TextDecoder 'shift_jis' はCP932相当をカバー) */
function decode(bytes: Uint8Array, encoding: 'cp932' | 'utf8'): string {
  const label = encoding === 'cp932' ? 'shift_jis' : 'utf-8';
  return new TextDecoder(label, { fatal: false }).decode(bytes);
}

const MAX_REDIRECTS = 3;

export async function fetchText(rawUrl: string, opts: FetchTextOptions): Promise<string> {
  let url = assertAllowedUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.collect.httpTimeoutMs);
  try {
    // リダイレクトは手動でたどり、途中経路のホストも毎回検証する (SSRF対策)
    let res: Response | null = null;
    for (let redirects = 0; ; redirects++) {
      await waitTurn();
      res = await fetch(url, {
        headers: {
          'User-Agent': config.collect.userAgent,
          Accept: 'text/html,application/json,text/plain,*/*',
          'Accept-Language': 'ja,en;q=0.5',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new HttpError(`redirect without Location: ${url.href}`, res.status);
        if (redirects >= MAX_REDIRECTS) throw new HttpError(`too many redirects from ${rawUrl}`);
        url = assertAllowedUrl(new URL(location, url).href);
        continue;
      }
      break;
    }
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} for ${url.href}`, res.status);
    }
    const bytes = await readBodyWithLimit(res, opts.maxBytes);
    return decode(bytes, opts.encoding ?? 'utf8');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new HttpError(`timeout after ${config.collect.httpTimeoutMs}ms: ${url.href}`);
    }
    throw new HttpError(`fetch failed: ${url.href}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** テスト用: レート制限をリセット */
export function _resetRateLimitForTest(): void {
  lastRequestAt = 0;
}
