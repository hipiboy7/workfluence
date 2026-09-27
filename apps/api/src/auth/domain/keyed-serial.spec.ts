import { describe, expect, it } from 'vitest';
import { KeyedSerial } from './keyed-serial';

/**
 * A등급 — 한 열쇠씩 줄 세우기 (P13 D.4, FR-1431). **한 계정의 로그인은 하나씩** 확인한다. 줄 안에서 잠금을 새로 읽으므로, 동시에 틀린
 * N건이 와도 확인까지 가는 것은 잠금 기준만큼이다(측정 S3 — 예전에는 동시에 틀린 10건이 1회로 세졌다). 맞는 로그인은 차례로 모두 들어간다.
 * 다른 계정끼리는 줄을 서지 않는다. 기다리는 동안 DB 연결을 쥐지 않는다 — 줄은 메모리의 약속 사슬이다.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('KeyedSerial', () => {
  it('같은 열쇠는 하나씩, 들어온 차례대로 돈다', async () => {
    const serial = new KeyedSerial();
    const order: string[] = [];
    const first = deferred();
    const runs = [
      serial.run('alice', async () => {
        order.push('a1 시작');
        await first.promise;
        order.push('a1 끝');
      }),
      serial.run('alice', async () => void order.push('a2')),
      serial.run('alice', async () => void order.push('a3')),
    ];
    await tick();
    expect(order).toEqual(['a1 시작']);
    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual(['a1 시작', 'a1 끝', 'a2', 'a3']);
  });

  it('다른 열쇠는 서로를 기다리지 않는다', async () => {
    const serial = new KeyedSerial();
    const hold = deferred();
    const order: string[] = [];
    const a = serial.run('alice', async () => {
      await hold.promise;
      order.push('alice');
    });
    await serial.run('bob', async () => void order.push('bob'));
    expect(order).toEqual(['bob']);
    hold.resolve();
    await a;
    expect(order).toEqual(['bob', 'alice']);
  });

  it('**실패한 작업도 줄을 푼다** — 안 풀면 그 계정은 영영 로그인하지 못한다', async () => {
    const serial = new KeyedSerial();
    await expect(serial.run('alice', async () => Promise.reject(new Error('DB 오류')))).rejects.toThrow('DB 오류');
    await expect(
      serial.run('alice', () => {
        throw new Error('바로 던짐');
      }),
    ).rejects.toThrow('바로 던짐');
    await expect(serial.run('alice', async () => 'ok')).resolves.toBe('ok');
  });

  it('**끝난 열쇠는 지운다** — 로그인한 적 있는 이름이 메모리에 쌓이지 않게', async () => {
    const serial = new KeyedSerial();
    await Promise.all(['a', 'b', 'c'].map((k) => serial.run(k, async () => k)));
    await Promise.allSettled([serial.run('d', async () => Promise.reject(new Error('x')))]);
    expect(serial.size).toBe(0);
  });

  it('작업의 값을 그대로 돌려준다', async () => {
    const serial = new KeyedSerial();
    await expect(Promise.all([1, 2, 3].map((n) => serial.run('k', async () => n * 2)))).resolves.toEqual([2, 4, 6]);
  });

  it('**앞이 끝나고 둘째가 도는 중에 온 셋째도 기다린다** — 끝난 사람이 열쇠를 지우면 셋째가 둘째와 함께 돌아 잠금이 다시 느슨해진다 (병합 전 자체 점검 9)', async () => {
    const serial = new KeyedSerial();
    const order: string[] = [];
    const first = deferred();
    const second = deferred();
    const a1 = serial.run('alice', async () => {
      await first.promise;
      order.push('a1 끝');
    });
    const a2 = serial.run('alice', async () => {
      order.push('a2 시작');
      await second.promise;
      order.push('a2 끝');
    });
    first.resolve();
    await a1;
    await tick();
    expect(order).toEqual(['a1 끝', 'a2 시작']);
    // 둘째가 도는 중에 셋째가 온다 — 줄의 꼬리는 둘째의 것이다
    const a3 = serial.run('alice', async () => void order.push('a3'));
    await tick();
    expect(order).toEqual(['a1 끝', 'a2 시작']);
    second.resolve();
    await Promise.all([a2, a3]);
    expect(order).toEqual(['a1 끝', 'a2 시작', 'a2 끝', 'a3']);
    expect(serial.size).toBe(0);
  });
});
