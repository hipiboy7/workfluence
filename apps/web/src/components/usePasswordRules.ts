import { useEffect, useState } from 'react';
import { PASSWORD_POLICY, passwordRuleText, type PasswordRulesView } from '@workfluence/shared';
import { api } from '../api';

/**
 * **비밀번호 안내문** — 운영 설정의 규칙을 따른다 (P13 FR-1472). 예전에는 고정 문자열이라 관리자가 규칙을 바꿔도 안내문은 그대로였다.
 * 로그인 전에도 읽는 규칙 API(`/api/auth/password-rules`)를 부른다. 읽기 전·실패하면 코드 기본값의 문장이다 — 서버가 어차피 다시 본다
 */
export function usePasswordRuleText(): string {
  const [rules, setRules] = useState<PasswordRulesView>({ minLength: PASSWORD_POLICY.minLength, minCharClasses: PASSWORD_POLICY.minCharClasses });
  useEffect(() => {
    let live = true;
    api<PasswordRulesView>('/api/auth/password-rules')
      .then((r) => live && setRules(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return passwordRuleText(rules);
}
