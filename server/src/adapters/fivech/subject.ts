import { decodeEntities } from './dat.js';

/**
 * subject.txt パーサ (CP932デコード済み文字列を受け取る)
 * 形式: 1792144754.dat<>タイトル  (11)
 */

export interface SubjectEntry {
  threadKey: string;
  title: string;
  resCount: number;
}

const LINE_RE = /^(\d+)\.dat<>(.*)\s\((\d+)\)\s*$/;

export function parseSubject(text: string): SubjectEntry[] {
  const out: SubjectEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) continue;
    const m = LINE_RE.exec(trimmed);
    if (!m) continue;
    out.push({
      threadKey: m[1]!,
      title: decodeEntities(m[2]!).trim(),
      resCount: Number(m[3]),
    });
  }
  return out;
}
