import { describe, expect, it } from 'vitest';
import { dueForRecheck, revocationReason, shouldTerminate } from './liveness';

describe('shouldTerminate — 하트비트 (P7 FR-801)', () => {
  it('pong이 돌아온 연결은 살려 둔다', () => {
    expect(shouldTerminate(true)).toBe(false);
  });

  it('직전 ping에 pong이 없었으면 끊는다', () => {
    expect(shouldTerminate(false)).toBe(true);
  });
});

describe('dueForRecheck — 재판정 차례 (P7 FR-800)', () => {
  it('주기가 지나지 않았으면 보지 않는다', () => {
    expect(dueForRecheck(1_000, 1_000 + 299_999, 300_000)).toBe(false);
  });

  it('주기가 꼭 찼으면 본다', () => {
    expect(dueForRecheck(1_000, 1_000 + 300_000, 300_000)).toBe(true);
  });

  it('갓 붙은 연결은 보지 않는다 — 업그레이드에서 이미 판정했다', () => {
    expect(dueForRecheck(5_000, 5_000, 300_000)).toBe(false);
  });

  it('시계가 뒤로 갔어도 끊지 않는다', () => {
    // NTP 보정으로 now가 과거가 될 수 있다. 음수 경과를 "지났다"로 보면
    // **모든 연결을 한꺼번에 재판정**해 DB를 때린다
    expect(dueForRecheck(10_000, 9_000, 300_000)).toBe(false);
  });
});

describe('revocationReason — 끊어야 하는가 (P7 FR-800)', () => {
  const ok = { sessionAlive: true, userActive: true, mustChangePassword: false, canWrite: true };

  it('전부 그대로면 끊지 않는다', () => {
    expect(revocationReason(ok)).toBeNull();
  });

  it('세션이 사라졌으면 끊는다 — 로그아웃·관리자 강제 종료·만료', () => {
    expect(revocationReason({ ...ok, sessionAlive: false })).toBe('세션 없음');
  });

  it('계정이 비활성이 됐으면 끊는다', () => {
    expect(revocationReason({ ...ok, userActive: false })).toBe('계정 비활성');
  });

  it('비밀번호 변경이 강제됐으면 끊는다', () => {
    expect(revocationReason({ ...ok, mustChangePassword: true })).toBe('비밀번호 변경 필요');
  });

  it('쓰기 권한을 잃었으면 끊는다 — Crew에서 빠졌거나 역할이 내려갔다', () => {
    expect(revocationReason({ ...ok, canWrite: false })).toBe('쓰기 권한 없음');
  });

  it('여러 개가 동시에 아니면 세션을 먼저 말한다 — 가장 넓은 이유가 먼저다', () => {
    expect(revocationReason({ sessionAlive: false, userActive: false, mustChangePassword: true, canWrite: false })).toBe('세션 없음');
  });
});
