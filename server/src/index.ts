import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { api } from './routes/index.js';
import { startScheduler } from './collector/scheduler.js';
import { runCollect, isCollectRunning } from './collector/collect.js';
import './db.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// セキュリティヘッダ
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src * data: blob:; media-src *; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://platform.twitter.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  );
  next();
});

// 書き込み系APIのCSRF対策: Originが送られてくる場合は localhost 系のみ許可
// (ローカルアプリ前提。curl等Originなしのクライアントは許可し、ブラウザからのクロスオリジンPOSTを防ぐ)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      res.status(403).json({ error: 'invalid origin' });
      return;
    }
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      res.status(403).json({ error: 'cross-origin write forbidden' });
      return;
    }
  }
  next();
});

app.use('/api', api);

// 本番: ビルド済みフロントを配信
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist, {
    maxAge: '1h',
    index: 'index.html',
    setHeaders(res, file) {
      if (path.extname(file) === '.html') res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  // SPAフォールバック ( /api 以外 )
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
}

// 起動時に一度だけ収集 (DB空の場合 or 明示フラグ)
// ローカルアプリのため 127.0.0.1 のみで待ち受け (LAN内からの操作・DNSリバインディング防止)
app.listen(config.port, '127.0.0.1', () => {
  console.log(`[matsuriscope] listening: http://localhost:${config.port}`);
  startScheduler();
  const shouldBootstrap = process.argv.includes('--collect-on-start') || process.env.COLLECT_ON_START === '1';
  if (shouldBootstrap && !isCollectRunning()) {
    void runCollect('startup').catch((e) => console.error('[startup collect]', e));
  }
});
