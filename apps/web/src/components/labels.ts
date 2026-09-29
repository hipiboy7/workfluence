import type { Role } from '@workfluence/shared';

/**
 * 화면에 보이는 이름 (P17 설계서 J.9-9) — 코드는 개발 용어라 한글로 보인다. 위 막대의 역할은 한글만, 사용자 관리처럼 코드를 함께 봐야 하는 곳은
 * "한글 (코드)" 꼴이다(`withCode`). 코드는 장애대응 가이드·시험이 찾는 이름이라 지우지 않는다
 */
export const ROLE_NAMES: Record<Role, string> = {
  root: '시스템 관리자',
  admin: '관리자',
  member: '일반 사용자',
};

/** "한글 (코드)" */
export const withCode = (name: string, code: string): string => (name === code ? code : `${name} (${code})`);
