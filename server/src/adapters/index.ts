import type { SourceAdapter } from './types.js';
import { fiveChAdapter } from './fivech/index.js';

/**
 * 収集元アダプタのレジストリ。
 * 収集コアはここ経由でのみアダプタにアクセスし、個別実装を直接importしない。
 * 将来 X/Reddit 等を追加する場合はここに登録する。
 */
export const adapters: readonly SourceAdapter[] = [fiveChAdapter];
