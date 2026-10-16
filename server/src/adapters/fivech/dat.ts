import type { SourcePost } from '../types.js';

/**
 * dat パーサ (CP932デコード済み文字列を受け取る)
 * 形式: 名前<>メール<>日付 ID:xxx<>本文<>[スレタイ(>>1のみ)]
 */

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 生HTML本文 → プレーンテキスト (表示用) */
export function bodyToPlainText(rawHtml: string): string {
  return decodeEntities(
    rawHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .trim(),
  );
}

export function parseDat(text: string): SourcePost[] {
  const posts: SourcePost[] = [];
  const lines = text.split('\n');
  let resNo = 0;
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) continue;
    resNo += 1; // 空でない行は壊れていてもレス番号を進める (番号ずれ防止)
    const fields = trimmed.split('<>');
    if (fields.length < 4) continue; // 壊れた行・あぼーん行対策
    posts.push({
      resNo,
      name: decodeEntities(fields[0] ?? '').trim(),
      dateText: (fields[2] ?? '').trim(),
      rawBodyHtml: fields[3] ?? '',
      bodyText: bodyToPlainText(fields[3] ?? ''),
    });
  }
  return posts;
}
