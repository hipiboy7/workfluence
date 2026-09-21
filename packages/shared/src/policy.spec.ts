import { describe, expect, it } from 'vitest';
import { POLICY_DEFAULTS, POLICY_KEYS, applyPolicy, validatePolicyPatch } from './policy';

/** A등급 (P4_설계서_Admin E절, FR-524). 테스트를 먼저 썼다. */

describe('applyPolicy — DB 값이 없으면 기본값 (FR-522)', () => {
  it('빈 값이면 전부 기본값이다', () => {
    expect(applyPolicy({})).toEqual(POLICY_DEFAULTS);
  });

  it('일부만 있으면 그것만 덮는다', () => {
    const p = applyPolicy({ uploadMaxMb: 50 });
    expect(p.uploadMaxMb).toBe(50);
    expect(p.sessionIdleMinutes).toBe(POLICY_DEFAULTS.sessionIdleMinutes);
  });

  it('**모르는 키는 버린다** — 옛 키가 남아 있어도 기동해야 한다', () => {
    expect(applyPolicy({ uploadMaxMb: 50, whoKnows: 1 } as Record<string, unknown>).uploadMaxMb).toBe(50);
    expect('whoKnows' in applyPolicy({ whoKnows: 1 } as Record<string, unknown>)).toBe(false);
  });

  it('DB에 든 올바른 확장자 목록은 그대로 얹는다', () => {
    // 이 분기가 비어 있어 A등급 브랜치 기준(90%)에 못 미쳤다 — 자체 점검 #6이 잡았다
    expect(applyPolicy({ allowedExtensions: ['pdf', 'png'] }).allowedExtensions).toEqual(['pdf', 'png']);
    // 목록 밖 확장자가 섞이면 통째로 버리고 기본값을 쓴다 (읽기는 던지지 않는다)
    expect(applyPolicy({ allowedExtensions: ['pdf', 'exe'] }).allowedExtensions).toEqual(POLICY_DEFAULTS.allowedExtensions);
  });

  it('**타입이 틀린 값은 버리고 기본값을 쓴다** — 관리 화면 밖에서 손댄 DB가 기동을 막지 않게', () => {
    expect(applyPolicy({ uploadMaxMb: 'big' } as Record<string, unknown>).uploadMaxMb).toBe(POLICY_DEFAULTS.uploadMaxMb);
    expect(applyPolicy({ uploadMaxMb: 0 } as Record<string, unknown>).uploadMaxMb).toBe(POLICY_DEFAULTS.uploadMaxMb);
  });
});

describe('validatePolicyPatch — 바꾸려는 값 판정 (FR-524)', () => {
  it('올바른 값은 통과한다', () => {
    expect(validatePolicyPatch({ uploadMaxMb: 50, sessionIdleMinutes: 60 })).toEqual([]);
  });

  it('**상한을 0으로 두면 아무도 못 올린다.** 범위를 벗어나면 막는다', () => {
    expect(validatePolicyPatch({ uploadMaxMb: 0 })).toHaveLength(1);
    expect(validatePolicyPatch({ uploadMaxMb: 100000 })).toHaveLength(1);
    expect(validatePolicyPatch({ sessionIdleMinutes: 0 })).toHaveLength(1);
    expect(validatePolicyPatch({ passwordMinLength: 3 })).toHaveLength(1);
    expect(validatePolicyPatch({ passwordMinCharClasses: 5 })).toHaveLength(1);
  });

  it('정수가 아니면 막는다', () => {
    expect(validatePolicyPatch({ uploadMaxMb: 1.5 })).toHaveLength(1);
  });

  it('모르는 키는 막는다 — 오타가 조용히 무시되면 "바꿨는데 안 먹는다"가 된다', () => {
    expect(validatePolicyPatch({ uploadMaxMB: 50 } as Record<string, unknown>)).toHaveLength(1);
  });

  it('허용 확장자는 소문자 목록이어야 하고 비어 있으면 안 된다', () => {
    expect(validatePolicyPatch({ allowedExtensions: ['pdf', 'png'] })).toEqual([]);
    expect(validatePolicyPatch({ allowedExtensions: [] })).toHaveLength(1);
    expect(validatePolicyPatch({ allowedExtensions: ['PDF'] })).toHaveLength(1);
    expect(validatePolicyPatch({ allowedExtensions: ['exe'] })).toHaveLength(1); // 판정 규칙에 없는 확장자
  });

  it('여러 개가 틀리면 여러 건을 돌려준다 — 한 번에 다 고칠 수 있게', () => {
    expect(validatePolicyPatch({ uploadMaxMb: 0, sessionIdleMinutes: 0 })).toHaveLength(2);
  });

  it('빈 변경은 막는다 — 아무것도 안 바꾸는 요청이 감사로그를 더럽힌다', () => {
    expect(validatePolicyPatch({})).toHaveLength(1);
  });
});

describe('POLICY_KEYS', () => {
  it('기본값과 키 집합이 같다 — 한쪽만 늘리면 조용히 빠진다', () => {
    expect([...POLICY_KEYS].sort()).toEqual(Object.keys(POLICY_DEFAULTS).sort());
  });
});
