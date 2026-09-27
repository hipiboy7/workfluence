import { describe, expect, it } from 'vitest';
import { ConcurrencyGate } from './concurrency-gate';

/**
 * A등급 — 동시 실행 상한 (P13 D.4, FR-1433). argon2는 한 건이 CPU 코어 하나를 넘게 쓴다. 한꺼번에 여럿을 돌리면 처리량은 그대로인데
 * 요청을 처리하는 스레드의 CPU를 빼앗는다(측정 S0a — 동시 1~2건의 처리량이 4건과 같거나 높았다). 넘는 것은 줄을 세운다.
 * 시험은 **끝나는 때를 손으로 정하는** 작업으로 한다 — 시계에 기대지 않는다.
 */

/** 밖에서 끝낼 수 있는 작업 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('ConcurrencyGate', () => {
  it('상한까지만 한꺼번에 돌리고 나머지는 기다린다', async () => {
    const gate = new ConcurrencyGate(2);
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 5 }, () => deferred());
    const runs = jobs.map((j) =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await j.promise;
        running -= 1;
      }),
    );
    await tick();
    expect(running).toBe(2);
    expect(gate.waiting).toBe(3);
    for (const j of jobs) {
      j.resolve();
      await tick();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(gate.active).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('들어온 차례대로 돈다', async () => {
    const gate = new ConcurrencyGate(1);
    const order: number[] = [];
    const first = deferred();
    const runs = [
      gate.run(async () => {
        order.push(0);
        await first.promise;
      }),
      gate.run(async () => void order.push(1)),
      gate.run(async () => void order.push(2)),
    ];
    await tick();
    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2]);
  });

  it('**실패한 작업도 자리를 돌려준다** — 안 돌려주면 몇 번의 실패로 로그인이 영영 줄에 선다', async () => {
    const gate = new ConcurrencyGate(1);
    await expect(gate.run(async () => Promise.reject(new Error('해시 실패')))).rejects.toThrow('해시 실패');
    await expect(
      gate.run(() => {
        throw new Error('바로 던짐');
      }),
    ).rejects.toThrow('바로 던짐');
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => 7)).resolves.toBe(7);
  });

  it('작업의 값을 그대로 돌려준다', async () => {
    const gate = new ConcurrencyGate(3);
    await expect(Promise.all([1, 2, 3, 4].map((n) => gate.run(async () => n * 10)))).resolves.toEqual([10, 20, 30, 40]);
  });

  it('상한은 1 이상의 정수다', () => {
    expect(() => new ConcurrencyGate(0)).toThrow(/1 이상/);
    expect(() => new ConcurrencyGate(1.5)).toThrow(/1 이상/);
    expect(() => new ConcurrencyGate(Number.NaN)).toThrow(/1 이상/);
  });
});
