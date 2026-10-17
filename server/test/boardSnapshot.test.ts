import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { fetchText } from '../src/httpClient.js';
import { FiveChAdapter } from '../src/adapters/fivech/index.js';
import type { SourceBoard } from '../src/adapters/types.js';

vi.mock('../src/httpClient.js', () => ({ fetchText: vi.fn() }));

const board: SourceBoard = { server: 'mi', boardKey: 'news4vip', name: 'VIP', category: '雑談系２', url: 'https://mi.5ch.io/news4vip/' };

beforeEach(() => vi.resetAllMocks());

describe('FiveChAdapter current board snapshot', () => {
  it('fetches exactly one bounded CP932 subject and keeps every unique thread regardless of hot caps or response count', async () => {
    const count = Math.max(config.collect.maxDatPerJob, config.collect.maxThreadsPerBoard) + 3;
    const lines = Array.from({ length: count }, (_, index) => `${1700000000 + index}.dat<>Thread ${index} (${index % 3})`);
    vi.mocked(fetchText).mockResolvedValue([...lines, lines[0], 'garbage'].join('\n'));
    const refs = await new FiveChAdapter().listBoardThreads(board);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(refs).toHaveLength(count);
    expect(refs[0]).toMatchObject({ board, threadKey: '1700000000', resCount: 0 });
    expect(refs.at(-1)?.threadKey).toBe(String(1700000000 + count - 1));
  });

  it('rejects excluded categories, mismatched identities and non-source URLs before making a request', async () => {
    const adapter = new FiveChAdapter();
    for (const candidate of [
      { ...board, category: 'BBSPINK' },
      { ...board, url: 'https://example.com/news4vip/' },
      { ...board, url: 'https://mi.5ch.io:444/news4vip/' },
      { ...board, url: 'https://mi.5ch.io/news4vip/?redirect=1' },
      { ...board, server: 'other' },
      { ...board, boardKey: '../news4vip' },
    ]) {
      await expect(adapter.listBoardThreads(candidate)).rejects.toThrow('not eligible');
    }
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('propagates a subject failure instead of pretending the current snapshot is empty', async () => {
    vi.mocked(fetchText).mockRejectedValue(new Error('HTTP 403'));
    await expect(new FiveChAdapter().listBoardThreads(board)).rejects.toThrow('HTTP 403');
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
});
