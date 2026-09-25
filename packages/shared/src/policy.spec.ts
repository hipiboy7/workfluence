import { describe, expect, it } from 'vitest';
import { POLICY_DEFAULTS, POLICY_KEYS, applyPolicy, mergePolicy, policyConsistencyProblems, validatePolicyPatch } from './policy';

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

/** Phase 10 (P10_설계서_Llm I절, FR-1131~1134) — 테스트를 먼저 썼다 */
describe('LLM 대화 보관 정책값', () => {
  it('기본값은 사용자 답 그대로다 — 7일 · 100개 · 고정 20개 (쟁점 5)', () => {
    expect(POLICY_DEFAULTS.llmRetentionDays).toBe(7);
    expect(POLICY_DEFAULTS.llmConversationMax).toBe(100);
    expect(POLICY_DEFAULTS.llmPinnedMax).toBe(20);
  });

  it('범위 밖은 막는다', () => {
    expect(validatePolicyPatch({ llmRetentionDays: 0 })).toHaveLength(1);
    expect(validatePolicyPatch({ llmRetentionDays: 366 })).toHaveLength(1);
    expect(validatePolicyPatch({ llmConversationMax: 0 })).toHaveLength(1);
    expect(validatePolicyPatch({ llmConversationMax: 1001 })).toHaveLength(1);
    expect(validatePolicyPatch({ llmPinnedMax: -1 })).toHaveLength(1);
    expect(validatePolicyPatch({ llmRetentionDays: 30, llmConversationMax: 300, llmPinnedMax: 0 })).toEqual([]);
  });

  it('**고정 수는 대화 수보다 작아야 한다** (FR-1134) — 같으면 고정만으로 상한이 차서 새 대화를 둘 자리가 없다', () => {
    expect(policyConsistencyProblems({ ...POLICY_DEFAULTS, llmPinnedMax: 100, llmConversationMax: 100 })).toHaveLength(1);
    expect(policyConsistencyProblems({ ...POLICY_DEFAULTS, llmPinnedMax: 150, llmConversationMax: 100 })).toHaveLength(1);
    expect(policyConsistencyProblems({ ...POLICY_DEFAULTS, llmPinnedMax: 99, llmConversationMax: 100 })).toEqual([]);
    expect(policyConsistencyProblems(POLICY_DEFAULTS)).toEqual([]);
  });

  it('**읽을 때 어긋난 짝은 고정 수를 낮춰 맞춘다** — 읽기는 던지지 않는다 (FR-522와 같은 판단)', () => {
    const p = applyPolicy({ llmConversationMax: 10, llmPinnedMax: 50 });
    expect(p.llmConversationMax).toBe(10);
    expect(p.llmPinnedMax).toBe(9);
    expect(policyConsistencyProblems(p)).toEqual([]);
  });
});

/** 검토 반영 (P10 코드 리뷰 — 짝 규칙이 이미 맞춘 값을 보고 지나간다). 테스트를 먼저 썼다 */
describe('mergePolicy — 짝을 맞추지 않고 합친다', () => {
  it('**어긋난 짝을 그대로 둔다** — 쓰기 판정은 이것을 봐야 한다. `applyPolicy`는 맞춘 값이라 판정을 지나가게 한다', () => {
    const merged = mergePolicy({ llmConversationMax: 10, llmPinnedMax: 50 });
    expect([merged.llmConversationMax, merged.llmPinnedMax]).toEqual([10, 50]);
    expect(policyConsistencyProblems(merged)).toHaveLength(1);
    expect(applyPolicy({ llmConversationMax: 10, llmPinnedMax: 50 }).llmPinnedMax).toBe(9);
  });

  it('틀린 값은 기본값으로 — 읽기와 같다', () => {
    expect(mergePolicy({ llmPinnedMax: 'x' } as Record<string, unknown>).llmPinnedMax).toBe(POLICY_DEFAULTS.llmPinnedMax);
    expect(mergePolicy({})).toEqual(POLICY_DEFAULTS);
  });
});
