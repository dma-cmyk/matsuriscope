import { config } from '../config.js';
import { runCollect } from './collect.js';

/** 定期収集スケジューラ (多重起動防止は collect 側の排他で担保) */

let timer: NodeJS.Timeout | undefined;

export function startScheduler(): void {
  const intervalMs = config.collect.intervalMinutes * 60 * 1000;
  timer = setInterval(() => {
    void runCollect('schedule').catch((e) => console.error('[scheduler]', e));
  }, intervalMs);
  timer.unref();
  console.log(`[scheduler] started: every ${config.collect.intervalMinutes} min`);
}

export function stopScheduler(): void {
  clearInterval(timer);
  timer = undefined;
}
