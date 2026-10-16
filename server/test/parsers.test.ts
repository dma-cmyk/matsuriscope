import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBbsMenu, DEFAULT_EXCLUDED_CATEGORIES } from '../src/adapters/fivech/boardList.js';
import { parseSubject } from '../src/adapters/fivech/subject.js';
import { parseDat, bodyToPlainText } from '../src/adapters/fivech/dat.js';
import { extractMediaFromPost } from '../src/adapters/fivech/media.js';
import { calcIkioi, buzzScore } from '../src/score.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function readFixtureCp932(name: string): string {
  const bytes = fs.readFileSync(path.join(fixtures, name));
  return new TextDecoder('shift_jis', { fatal: false }).decode(bytes);
}

describe('parseBbsMenu (実データ)', () => {
  it('板一覧を抽出できる', () => {
    const boards = parseBbsMenu(fs.readFileSync(path.join(fixtures, 'bbsmenu.json'), 'utf8'));
    expect(boards.length).toBeGreaterThan(500);
    const vip = boards.find((b) => b.boardKey === 'news4vip');
    expect(vip).toBeDefined();
    expect(vip!.server).toBe('mi');
    expect(vip!.url).toMatch(/^https:\/\/[a-z0-9-]+\.5ch\.io\/news4vip\/$/);
  });

  it('板でないURL (bbspink TOP等) を除外する', () => {
    const boards = parseBbsMenu(fs.readFileSync(path.join(fixtures, 'bbsmenu.json'), 'utf8'));
    for (const b of boards) {
      expect(b.boardKey).not.toBe('NONE');
      expect(b.url).toMatch(/^https:\/\/[a-z0-9-]+\.(5ch\.io|5ch\.net|bbspink\.com)\/[a-zA-Z0-9_]+\/$/);
    }
  });

  it('bbspink等のカテゴリが除外対象に含まれる', () => {
    expect(DEFAULT_EXCLUDED_CATEGORIES['BBSPINK']).toBe(true);
  });
});

describe('parseSubject (実データ)', () => {
  it('スレッドキー・タイトル・レス数を抽出できる', () => {
    const entries = parseSubject(readFixtureCp932('subject_news4vip.txt'));
    expect(entries.length).toBeGreaterThan(100);
    for (const e of entries.slice(0, 20)) {
      expect(e.threadKey).toMatch(/^\d{9,11}$/);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.resCount).toBeGreaterThan(0);
    }
  });

  it('壊れた行をスキップする', () => {
    const entries = parseSubject('1792144754.dat<>正常 (11)\ngarbage line\n\n123.dat<>欠損\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.threadKey).toBe('1792144754');
  });
});

describe('parseDat (実データ)', () => {
  it('レスを番号付きで抽出できる', () => {
    const posts = parseDat(readFixtureCp932('dat_sample.dat'));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0]!.resNo).toBe(1);
    expect(posts[0]!.bodyText.length).toBeGreaterThan(0);
    // res番号が連番であること
    posts.forEach((p, i) => expect(p.resNo).toBe(i + 1));
  });

  it('bodyToPlainText: br→改行、タグ除去、エンティティデコード', () => {
    expect(bodyToPlainText('a<br>b&lt;c&amp;d')).toBe('a\nb<c&d');
    expect(bodyToPlainText('<a href="https://x.com">link</a>')).toBe('link');
  });
});

describe('extractMediaFromPost', () => {
  function post(body: string, resNo = 1) {
    return { resNo, name: '', dateText: '', rawBodyHtml: body, bodyText: bodyToPlainText(body) };
  }

  it('画像直リンクを image/gif に分類する', () => {
    const m = extractMediaFromPost(post('https://i.imgur.com/abc.jpg と https://x.example.com/a.GIF'));
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ type: 'image', previewable: true });
    expect(m[1]).toMatchObject({ type: 'gif' });
  });

  it('mp4/webm を video に分類する', () => {
    const m = extractMediaFromPost(post('https://video.twimg.com/ext_tw_video/1/vid/avc1/a.mp4'));
    expect(m[0]).toMatchObject({ type: 'video', previewable: true });
  });

  it('YouTube を正規化しサムネイルを付与する', () => {
    const m = extractMediaFromPost(post('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s'));
    expect(m[0]).toMatchObject({ type: 'youtube', previewable: true });
    expect(m[0]!.canonicalUrl).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(m[0]!.thumbnailUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    // shorts / youtu.be も同一canonicalに
    const m2 = extractMediaFromPost(post('https://youtu.be/dQw4w9WgXcQ?si=xyz'));
    expect(m2[0]!.canonicalUrl).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('X/Twitter status を twitter 型に分類し canonical を統一する', () => {
    const a = extractMediaFromPost(post('https://twitter.com/foo/status/1234567890'));
    const b = extractMediaFromPost(post('https://x.com/foo/status/1234567890/photo/1'));
    expect(a[0]!.type).toBe('twitter');
    expect(a[0]!.canonicalUrl).toBe(b[0]!.canonicalUrl);
    expect(a[0]!.previewable).toBe(false);
  });

  it('imgur裸リンクは other (プレビュー不可) にする', () => {
    const m = extractMediaFromPost(post('https://imgur.com/6gsZV4U'));
    expect(m[0]).toMatchObject({ type: 'other', previewable: false });
  });

  it('5ch自身の画像は除外する', () => {
    const m = extractMediaFromPost(post('https://img.5ch.io/ico/foo.gif https://i.imgur.com/ok.png'));
    expect(m).toHaveLength(1);
    expect(m[0]!.type).toBe('image');
  });

  it('同一canonicalの重複を1つにまとめる', () => {
    const m = extractMediaFromPost(post('https://i.imgur.com/dup.jpg<br>https://i.imgur.com/dup.jpg'));
    expect(m).toHaveLength(1);
  });

  it('実データのdatからメディアを抽出できる', () => {
    const posts = parseDat(readFixtureCp932('dat_sample.dat'));
    const all = posts.flatMap((p) => extractMediaFromPost(p));
    // 実フィクスチャにimgurリンクが存在することを確認済み
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((m) => m.resNo >= 1)).toBe(true);
  });

  it('URL末尾の句読点・括弧を取り除く', () => {
    const m = extractMediaFromPost(post('見て https://i.imgur.com/x.png。あと(https://i.imgur.com/y.jpg)'));
    expect(m.map((x) => x.url)).toEqual(['https://i.imgur.com/x.png', 'https://i.imgur.com/y.jpg']);
  });
});

describe('score', () => {
  const DAY = 86400;
  it('勢い = レス数/経過日数', () => {
    const now = 1_800_000_000;
    expect(calcIkioi(100, now - DAY, now)).toBeCloseTo(100);
    expect(calcIkioi(100, now - DAY / 2, now)).toBeCloseTo(200);
  });

  it('新スレ直後の発散を防ぐ (経過1時間未満は1時間扱い)', () => {
    const now = 1_800_000_000;
    const v = calcIkioi(10, now - 60, now);
    expect(v).toBeCloseTo(10 / (3600 / DAY));
  });

  it('buzzスコアは再出現数で対数ボーナス', () => {
    expect(buzzScore(100, 1)).toBeCloseTo(100);
    expect(buzzScore(100, 5)).toBeGreaterThan(100);
    expect(buzzScore(100, 5)).toBeLessThan(150);
  });
});
