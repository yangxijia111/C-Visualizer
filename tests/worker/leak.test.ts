// 资源泄漏回归（P13 §10 / 任务书 §43）：连续 100 次 Run 不得累积 Worker / 监听器
import { describe, expect, it } from 'vitest';
import { RuntimeClient } from '../../src/worker/client';
import { FakeWorker } from './fake-worker';

const PROGRAM = `
int main() {
  int sum = 0;
  for (int i = 0; i < 20; i++) {
    sum = sum + i;
  }
  return sum % 256;
}
`;

describe('连续 100 次 Run', () => {
  it('单 Worker 复用，全部到达终态，无泄漏增长', async () => {
    const fakes: FakeWorker[] = [];
    const client = new RuntimeClient({
      workerFactory: () => {
        const f = new FakeWorker();
        fakes.push(f);
        return f;
      },
      readyTimeoutMs: 5000,
    });
    await client.ensureReady();

    const messagesSeen: number[] = [];
    for (let i = 0; i < 100; i++) {
      const log = { batches: 0, finished: 0 };
      client.run(PROGRAM, { batchSize: 10 }, {
        onBatch: () => { log.batches++; },
        onFinished: () => { log.finished++; },
      });
      // 等待本 run 全部终态（FakeWorker 串行处理，下一个 run 排在其后）
      for (const f of fakes) await f.settle();
      await FakeWorker.flush();
      expect(log.finished).toBe(1);
      messagesSeen.push(log.batches);
    }

    // 单 Worker 复用：100 次 run 只创建 1 个实例（无 terminate/重建）
    expect(fakes.length).toBe(1);
    expect(fakes[0].terminated).toBe(false);
    // 每次运行的批次数恒定（无消息积压跨 run 累积）
    expect(new Set(messagesSeen).size).toBe(1);
    expect(client.activeRunId).toBeNull();
    client.dispose();
    expect(fakes[0].terminated).toBe(true);
  });

  it('取消与重建交替 20 轮：Worker 实例数有界（每轮最多 +1），全部可恢复', async () => {
    const fakes: FakeWorker[] = [];
    const client = new RuntimeClient({
      workerFactory: () => {
        const f = new FakeWorker();
        fakes.push(f);
        return f;
      },
      readyTimeoutMs: 5000,
    });
    await client.ensureReady();

    for (let i = 0; i < 20; i++) {
      const log = { finished: '' };
      client.run(PROGRAM, { batchSize: 10 }, {
        onFinished: (status) => { log.finished = status; },
      });
      client.cancelActive(); // 立即取消（合成 cancelled 终态 + terminate）
      await FakeWorker.flush();
      expect(log.finished).toBe('cancelled');
      // 下一次 run 会重建 Worker
      const ok = { status: '' };
      client.run(PROGRAM, { batchSize: 100 }, {
        onFinished: (status) => { ok.status = status; },
      });
      for (const f of fakes) await f.settle();
      await FakeWorker.flush();
      expect(ok.status).toBe('completed');
    }
    // 上界：初始 1 个 + 每轮取消重建最多 1 个 = 21（不会无界增长）
    expect(fakes.length).toBeLessThanOrEqual(21);
    client.dispose();
  });
});
