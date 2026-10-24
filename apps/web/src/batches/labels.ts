// Small display helpers the batch pages share.
import type { Batch, Fixture } from '@pdf-generator/contract';

export const batchStatusLabel: Record<Batch['status'], string> = {
  queued: '排隊中',
  running: '產生中',
  completed: '完成',
  failed: '失敗',
};

export const fixtureStatusLabel: Record<Fixture['status'], string> = {
  pending: '等待中',
  completed: '完成',
  failed: '失敗',
};

/** A batch still changes until it is completed or failed. */
export function isFinished(batch: Batch): boolean {
  return batch.status === 'completed' || batch.status === 'failed';
}

/** One line of progress, e.g. 完成 3／5 · 失敗 0 · 自我檢查 通過 3、未過 0. */
export function progressLine({ count, progress }: Batch): string {
  return `完成 ${progress.completed}／${count} · 失敗 ${progress.failed} · 自我檢查 通過 ${progress.checkPassed}、未過 ${progress.checkFailed}`;
}
