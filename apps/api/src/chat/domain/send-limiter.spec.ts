import { describe, expect, it } from 'vitest';
import { SendLimiter } from './send-limiter';

describe('SendLimiter (NFR-240 · 보안 검토 2)', () => {
  it('사용자마다 따로 센다 — 한 사람이 다른 사람의 몫을 쓰지 않는다', () => {
    const l = new SendLimiter(2, 60_000);
    expect([l.take('a', 0), l.take('a', 1), l.take('a', 2)]).toEqual([true, true, false]);
    expect(l.take('b', 3)).toBe(true);
  });
  it('창이 지나면 다시 받는다', () => {
    const l = new SendLimiter(1, 1_000);
    l.take('a', 0);
    expect(l.take('a', 999)).toBe(false);
    expect(l.take('a', 1_000)).toBe(true);
  });
  it('쉬는 사용자의 창은 쓸어 내도 한도가 새지 않는다', () => {
    const l = new SendLimiter(1, 1_000);
    l.take('a', 0);
    l.take('b', 5_000); // 쓸어 내는 때 — a의 창은 지났으니 지워진다
    expect(l.take('a', 5_001)).toBe(true);
    expect(l.take('a', 5_002)).toBe(false);
  });
});
