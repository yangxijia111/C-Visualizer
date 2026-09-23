// RuntimeClient 测试：READY 门闩 / runId 过滤 / Worker 故障恢复 / 重建
import { describe, expect, it } from 'vitest';
import { RuntimeClient } from '../../src/worker/client';
import { FakeWorker, makeRunLog } from './fake-worker';

const PROGRAM = `
int main() {
  int sum = 0;
  for (int i = 0; i < 25; i++) {
    sum = sum + i;
  }
  return sum;
}
`;

function makeClient(timeout = 2000): { client: RuntimeClient; fakes: FakeWorker[] } {
  const fakes: FakeWorker[] = [];
  const client = new RuntimeClient({
    workerFactory: () => {
      const f = new FakeWorker();
      fakes.push(f);
      return f;
    },
    readyTimeoutMs: timeout,
  });
  return { client, fakes };
}

async function settleAll(fakes: FakeWorker[]): Promise<void> {
  for (const f of fakes) await f.settle();
  await FakeWorker.flush();
}

describe('RuntimeClient：READY 与预热', () => {
  it('ensureReady 在 READY 到达后 resolve', async () => {
    const { client } = makeClient();
    await expect(client.ensureReady()).resolves.toBeUndefined();
    client.dispose();
  });

  it('READY 超时 → ensureReady reject（看门狗）', async () => {
    const failing = new RuntimeClient({
      workerFactory: () => new FakeWorker({ skipInit: true }),
      readyTimeoutMs: 30,
    });
    await expect(failing.ensureReady()).rejects.toThrow('初始化超时');
    failing.dispose();
  });

  it('Worker 级初始化失败（WORKER_ERROR null）→ ensureReady reject 且报错信息透传', async () => {
    const fakes: FakeWorker[] = [];
    const client = new RuntimeClient({
      workerFactory: () => {
        const f = new FakeWorker({ skipInit: true });
        fakes.push(f);
        return f;
      },
      readyTimeoutMs: 2000,
    });
    const p = client.ensureReady();
    fakes[0].injectFromWorker({ type: 'WORKER_ERROR', runId: null, message: 'wasm 加载失败' });
    await expect(p).rejects.toThrow('wasm 加载失败');
    client.dispose();
  });
});

describe('RuntimeClient：run 生命周期与 runId 防竞态', () => {
  it('完整 run：started → batches → finished，按 startIndex 连续', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    const { log, cb } = makeRunLog();
    client.run(PROGRAM, { batchSize: 10 }, cb);
    await settleAll(fakes);

    expect(log.startedWith).not.toBeNull();
    expect(log.finished).toEqual({ status: 'completed', output: '', totalSteps: 0 + log.batches.reduce((a, b) => a + b.entries.length, 0) });
    let expected = 0;
    for (const b of log.batches) {
      expect(b.startIndex).toBe(expected);
      expected += b.entries.length;
    }
    client.dispose();
  });

  it('旧 run 消息（过期 runId）被静默丢弃：A 启动后立即启动 B，A 的回调全空、B 完整', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    const a = makeRunLog();
    const b = makeRunLog();
    client.run(PROGRAM, { batchSize: 10 }, a.cb);
    client.run(PROGRAM, { batchSize: 10 }, b.cb); // B 立即取代 A 成为活跃 run
    await settleAll(fakes);

    expect(a.log.startedWith).toBeNull();
    expect(a.log.batches).toEqual([]);
    expect(a.log.finished).toBeNull();
    expect(b.log.startedWith).not.toBeNull();
    expect(b.log.finished).not.toBeNull();
    expect(b.log.finished!.status).toBe('completed');
    expect(client.activeRunId).toBeNull();
    client.dispose();
  });

  it('伪造的过期 runId 消息被丢弃，不触碰活跃 run 的回调', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    const { log, cb } = makeRunLog();
    const rid = client.run(PROGRAM, { batchSize: 100 }, cb);
    fakes[0].injectFromWorker({ type: 'RUN_FINISHED', runId: rid + 999, status: 'completed', output: 'bogus', totalSteps: 1 });
    await settleAll(fakes);
    expect(log.finished).not.toBeNull();
    expect(log.finished!.output).toBe(''); // 真实终态的 output（伪造消息未落地）
    client.dispose();
  });

  it('编译错误 → onCompileError 终态，activeRunId 清空', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    const { log, cb } = makeRunLog();
    client.run('int main( {', undefined, cb);
    await settleAll(fakes);
    expect(log.compileErrors).not.toBeNull();
    expect(log.finished).toBeNull();
    expect(client.activeRunId).toBeNull();
    client.dispose();
  });
});

describe('RuntimeClient：故障恢复', () => {
  it('Worker crash → 活跃 run 得到 onRunError 终态；下一次 run 自动重建 Worker 并成功', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    const first = makeRunLog();
    client.run(PROGRAM, { batchSize: 100 }, first.cb);
    fakes[0].crash('boom');
    await FakeWorker.flush();
    expect(first.log.runErrors).toEqual(['boom']);
    expect(first.log.finished).toBeNull();
    expect(client.activeRunId).toBeNull();

    const second = makeRunLog();
    client.run(PROGRAM, { batchSize: 100 }, second.cb);
    await settleAll(fakes);
    expect(fakes.length).toBe(2); // 重建了新 Worker
    expect(second.log.finished).not.toBeNull();
    expect(second.log.finished!.status).toBe('completed');
    client.dispose();
  });

  it('初始化失败后重试：ensureReady 再次调用会重建 Worker 并成功', async () => {
    const fakes: FakeWorker[] = [];
    const client = new RuntimeClient({
      workerFactory: () => {
        const f = new FakeWorker({ skipInit: fakes.length === 0 }); // 第一次坏
        fakes.push(f);
        return f;
      },
      readyTimeoutMs: 2000,
    });
    await expect(client.ensureReady()).rejects.toThrow();
    await expect(client.ensureReady()).resolves.toBeUndefined();
    expect(fakes.length).toBe(2);
    client.dispose();
  });

  it('消息序列化失败（onmessageerror）→ 活跃 run 得到终态，不悬挂', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    const { log, cb } = makeRunLog();
    client.run(PROGRAM, { batchSize: 100 }, cb);
    fakes[0].onmessageerror?.(undefined);
    await FakeWorker.flush();
    expect(log.runErrors.length).toBe(1);
    expect(client.activeRunId).toBeNull();
    client.dispose();
  });
});

describe('RuntimeClient：cancel 与 dispose', () => {
  it('cancel 发送 CANCEL 消息（runId 对齐活跃 run）', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    const sent: unknown[] = [];
    const orig = fakes[0].postMessage.bind(fakes[0]);
    fakes[0].postMessage = (msg) => { sent.push(msg); orig(msg); };
    const rid = client.run(PROGRAM, undefined, makeRunLog().cb);
    client.cancel();
    await settleAll(fakes);
    expect(sent.some((m) => (m as { type: string }).type === 'CANCEL' && (m as { runId: number }).runId === rid)).toBe(true);
    client.dispose();
  });

  it('dispose 后 worker 被 terminate，再次 run 自动重建', async () => {
    const { client, fakes } = makeClient();
    await client.ensureReady();
    client.dispose();
    expect(fakes[0].terminated).toBe(true);
    const { log, cb } = makeRunLog();
    client.run(PROGRAM, { batchSize: 100 }, cb);
    await settleAll(fakes);
    expect(log.finished).not.toBeNull();
    client.dispose();
  });
});
