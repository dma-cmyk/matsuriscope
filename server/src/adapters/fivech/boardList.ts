import type { SourceBoard } from '../types.js';

/**
 * menu.5ch.io/bbsmenu.json (5ch公式・専ブラ推奨JSON) のパーサ。
 * URL例: https://mi.5ch.io/news4vip/ → server="mi", boardKey="news4vip"
 */

interface BbsMenuBoard {
  board_name?: string;
  directory_name?: string;
  url?: string;
  category_name?: string;
}

interface BbsMenuCategory {
  category_name?: string;
  category_content?: BbsMenuBoard[];
}

const BOARD_URL_RE = /^https?:\/\/([a-z0-9-]+)\.(5ch\.io|5ch\.net|bbspink\.com)\/([a-zA-Z0-9_]+)\/?$/;

/** デフォルトで収集対象外にするカテゴリ (アダルト・隔離系) */
export const DEFAULT_EXCLUDED_CATEGORIES: Record<string, true> = {
  BBSPINK: true,
  be: true,
  隔離: true,
  荒野: true,
  裏社会: true,
};

export function parseBbsMenu(jsonText: string): SourceBoard[] {
  let data: { menu_list?: BbsMenuCategory[] };
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('bbsmenu.json: invalid JSON');
  }
  const boards: SourceBoard[] = [];
  for (const cat of data.menu_list ?? []) {
    const category = cat.category_name ?? 'その他';
    for (const b of cat.category_content ?? []) {
      if (!b.url || !b.board_name || !b.directory_name || b.directory_name === 'NONE') continue;
      const m = BOARD_URL_RE.exec(b.url);
      if (!m) continue; // トップページ等、板でないURLを除外
      boards.push({
        server: m[1]!,
        boardKey: m[3]!,
        name: b.board_name,
        category,
        url: `https://${m[1]}.${m[2]}/${m[3]}/`,
      });
    }
  }
  return boards;
}
