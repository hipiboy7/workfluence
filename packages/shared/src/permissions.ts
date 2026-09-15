import type { Role } from './constants';

/**
 * 권한 판정 순수 함수 (CLAUDE.md 7절 "권한 판정은 shared 순수 함수로 한 곳에서").
 * 프로토타입은 시스템 역할 2단계만 본다. 스페이스·페이지 단위 권한은 Phase 4에서 이 파일을 확장한다.
 */

export type Principal = {
  id: string;
  role: Role;
};

export type Action =
  | 'user.manage'
  | 'audit.read'
  | 'space.create'
  | 'space.delete'
  | 'space.edit'
  | 'page.read'
  | 'page.write'
  | 'page.delete';

/** 역할별 허용 행위. 기본 거부: 여기 없는 조합은 전부 false. */
const GRANTS: Record<Role, ReadonlySet<Action>> = {
  admin: new Set<Action>([
    'user.manage',
    'audit.read',
    'space.create',
    'space.delete',
    'space.edit',
    'page.read',
    'page.write',
    'page.delete',
  ]),
  member: new Set<Action>(['space.create', 'space.edit', 'page.read', 'page.write', 'page.delete']),
};

export function can(principal: Principal | null | undefined, action: Action): boolean {
  if (!principal) return false;
  const grants = GRANTS[principal.role];
  return grants ? grants.has(action) : false;
}

/** 비밀번호 정책 판정. 통과하면 빈 배열, 아니면 위반 사유 목록. */
export function checkPasswordPolicy(
  password: string,
  policy: { minLength: number; minCharClasses: number },
): string[] {
  const reasons: string[] = [];
  if (password.length < policy.minLength) reasons.push(`${policy.minLength}자 이상이어야 한다`);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < policy.minCharClasses) reasons.push(`영문 대·소문자, 숫자, 특수문자 중 ${policy.minCharClasses}종 이상`);
  if (/\s/.test(password)) reasons.push('공백을 포함할 수 없다');
  return reasons;
}
