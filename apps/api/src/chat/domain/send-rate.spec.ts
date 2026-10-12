import { describe, expect, it } from 'vitest';
import { SendRateWindow } from './send-rate';

describe('SendRateWindow (NFR-240)', () => {
  it('분당 한도까지 받고 넘으면 거절한다', () => {
    const w = new SendRateWindow(3, 60_000);
    expect([0, 1, 2].map((t) => w.take(t))).toEqual([true, true, true]);
    expect(w.take(3)).toBe(false);
  });
  it('창이 지나면 다시 받는다', () => {
    const w = new SendRateWindow(2, 60_000);
    w.take(0);
    w.take(10);
    expect(w.take(59_999)).toBe(false);
    expect(w.take(60_000)).toBe(true); // 0의 몫이 풀렸다
    expect(w.take(60_001)).toBe(false); // 10의 몫은 아직
    expect(w.take(60_010)).toBe(true);
  });
  it('거절된 시도는 한도를 쓰지 않는다 — 계속 두드려도 창이 밀리지 않는다', () => {
    const w = new SendRateWindow(1, 1_000);
    w.take(0);
    for (let t = 1; t < 1_000; t += 100) expect(w.take(t)).toBe(false);
    expect(w.take(1_000)).toBe(true);
  });
});
