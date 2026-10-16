/**
 * 勢い・話題性スコア計算 (純粋関数)
 *
 * 勢い (ikioi):
 *   5chのスレッドキーは作成時刻のUnix秒。
 *   勢い = レス数 / 経過日数  — 従来の専用ブラウザと同じ定義。
 *   新スレ直後の発散を防ぐため経過時間の下限を1時間とする。
 *
 * 話題性スコア (buzz):
 *   buzz = 勢い × (1 + 0.25 × ln(出現スレッド数))
 *   同一メディアが複数スレッドで再共有されている場合に対数ボーナスを与える。
 *   メディア自体への評価数ではなく、あくまで出典スレッドの勢いが基礎。
 */

const MIN_AGE_SECONDS = 3600; // 1時間
const SECONDS_PER_DAY = 86400;

export function calcIkioi(resCount: number, createdAtSec: number, nowSec: number): number {
  const ageSec = Math.max(nowSec - createdAtSec, MIN_AGE_SECONDS);
  return resCount / (ageSec / SECONDS_PER_DAY);
}

export function buzzScore(ikioi: number, occurrenceCount: number): number {
  const occ = Math.max(occurrenceCount, 1);
  return ikioi * (1 + 0.25 * Math.log(occ));
}
