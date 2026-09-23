import { describe, expect, it, vi } from 'vitest';
import { RevocationBus } from './revocation.bus';

describe('RevocationBus (P7 FR-805)', () => {
  it('구독자에게 사용자 id를 넘긴다', () => {
    const bus = new RevocationBus();
    const seen: string[] = [];
    bus.onRevoke((id) => seen.push(id));
    bus.revoke('u1');
    expect(seen).toEqual(['u1']);
  });

  it('구독자가 없어도 터지지 않는다', () => {
    expect(() => new RevocationBus().revoke('u1')).not.toThrow();
  });

  it('구독을 해제하면 더 받지 않는다', () => {
    const bus = new RevocationBus();
    const fn = vi.fn();
    const off = bus.onRevoke(fn);
    off();
    bus.revoke('u1');
    expect(fn).not.toHaveBeenCalled();
  });

  it('한 구독자가 던져도 나머지는 받는다 — 비밀번호 변경이 실패하면 안 된다', () => {
    const bus = new RevocationBus();
    const later = vi.fn();
    bus.onRevoke(() => {
      throw new Error('소켓을 닫다 실패');
    });
    bus.onRevoke(later);
    expect(() => bus.revoke('u1')).not.toThrow();
    expect(later).toHaveBeenCalledWith('u1', undefined);
  });
});

describe('세션 하나만 끊기 (P7 보안 검토 F1)', () => {
  it('`sid`를 주면 그대로 전달한다 — 로그아웃은 그 브라우저 하나의 일이다', () => {
    const bus = new RevocationBus();
    const seen: [string, string | undefined][] = [];
    bus.onRevoke((id, sid) => seen.push([id, sid]));
    bus.revoke('u1', 'sid-abc');
    expect(seen).toEqual([['u1', 'sid-abc']]);
  });
});
