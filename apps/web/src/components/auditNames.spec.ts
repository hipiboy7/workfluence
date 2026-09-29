import { AUDIT_ACTIONS } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_NAMES, auditActionName } from './auditNames';

/** 감사 행위의 한글 이름 (P17 설계서 J.9-9). 빠진 종류는 타입이 막고, 여기서는 겹침과 모르는 코드를 본다 */
describe('AUDIT_ACTION_NAMES', () => {
  it('**종류마다 이름이 하나씩이고 서로 겹치지 않는다** — 겹치면 행위 고르기 칸에서 두 종류가 같은 이름으로 보인다', () => {
    const names = AUDIT_ACTIONS.map((a) => AUDIT_ACTION_NAMES[a]);
    expect(names.every((n) => n.trim().length > 0)).toBe(true);
    expect(new Set(names).size).toBe(AUDIT_ACTIONS.length);
    expect(Object.keys(AUDIT_ACTION_NAMES).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it('모르는 코드는 이름이 없다 — 객체의 기본 속성 이름도 이름으로 읽지 않는다', () => {
    expect(auditActionName('auth.login.success')).toBe('로그인 성공');
    expect(auditActionName('old.kind')).toBeNull();
    expect(auditActionName('constructor')).toBeNull();
  });
});
