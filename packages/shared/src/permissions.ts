import type { Role, SpaceKind, SpaceMemberRole, SpaceStatus } from './constants';

/**
 * 권한 판정 순수 함수 (CLAUDE.md 7절 "권한 판정은 shared 순수 함수로 한 곳에서").
 * - can(): 시스템 역할 기준의 거친 판정 (가드에서 사용)
 * - spaceAccess(): 스페이스 단위 판정 (서비스에서 사용)
 * - canAssignRole() / canManageUser(): 사용자 관리 시 역할 간 우열
 */

export type Principal = {
  id: string;
  role: Role;
};

export type Action =
  | 'user.manage' // 목록·생성·승인·초기화·잠금 해제
  | 'user.role.change'
  | 'audit.read'
  | 'system.manage' // root 전용
  | 'settings.manage' // 담당자 안내문 등
  | 'space.create'
  | 'space.manage' // 전체 스페이스 조회·상태 변경·중지 스페이스 삭제
  | 'category.create'
  | 'page.read'
  | 'page.write'
  | 'page.delete';

/** 역할별 허용 행위. 기본 거부: 여기 없는 조합은 전부 false. */
const GRANTS: Record<Role, ReadonlySet<Action>> = {
  root: new Set<Action>([
    'user.manage',
    'user.role.change',
    'audit.read',
    'system.manage',
    'settings.manage',
    'space.create',
    'space.manage',
    'category.create',
    'page.read',
    'page.write',
    'page.delete',
  ]),
  admin: new Set<Action>([
    'user.manage',
    'user.role.change',
    'audit.read',
    'settings.manage',
    'space.create',
    'space.manage',
    'category.create',
    'page.read',
    'page.write',
    'page.delete',
  ]),
  member: new Set<Action>(['space.create', 'category.create', 'page.read', 'page.write', 'page.delete']),
};

export function can(principal: Principal | null | undefined, action: Action): boolean {
  if (!principal) return false;
  const grants = GRANTS[principal.role];
  return grants ? grants.has(action) : false;
}

export function isAdminRole(role: Role): boolean {
  return role === 'root' || role === 'admin';
}

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, root: 2 };

/** actor가 target에게 role을 부여할 수 있는가. root만 root를 부여한다. admin은 admin·member. */
export function canAssignRole(actor: Principal, role: Role): boolean {
  if (actor.role === 'root') return true;
  if (actor.role === 'admin') return role !== 'root';
  return false;
}

/** actor가 targetRole의 사용자를 관리(승인·초기화·잠금 해제·역할 변경)할 수 있는가. admin은 root를 건드릴 수 없다. */
export function canManageUser(actor: Principal, targetRole: Role): boolean {
  if (!isAdminRole(actor.role)) return false;
  return ROLE_RANK[actor.role] >= ROLE_RANK[targetRole];
}

export type SpaceLike = {
  kind: SpaceKind;
  status: SpaceStatus;
  createdBy: string;
};

export type SpaceAccess = {
  canRead: boolean;
  canWrite: boolean;
  canManageMembers: boolean;
  canChangeStatus: boolean;
  canDelete: boolean;
  isOwner: boolean;
};

const NO_ACCESS: SpaceAccess = {
  canRead: false,
  canWrite: false,
  canManageMembers: false,
  canChangeStatus: false,
  canDelete: false,
  isOwner: false,
};

/**
 * 스페이스 접근 판정 (docs/prompts/prototype-v2.md 2절 7·8·11번).
 * - 개인: 생성자와 관리자만. Crew 없음.
 * - 팀: Crew(owner·editor·viewer)만 읽기. owner·editor·관리자만 쓰기.
 * - 중지 상태: 누구도 쓰기 불가(읽기 전용).
 * - 삭제: 생성자는 Crew가 본인뿐(memberCount < 2)일 때, 관리자는 중지 상태일 때.
 */
export function spaceAccess(
  principal: Principal | null | undefined,
  space: SpaceLike,
  membership: SpaceMemberRole | null,
  memberCount: number,
): SpaceAccess {
  if (!principal) return NO_ACCESS;
  const admin = isAdminRole(principal.role);
  const isOwner = space.createdBy === principal.id || membership === 'owner';
  const active = space.status === 'active';

  if (space.kind === 'personal') {
    const canRead = isOwner || admin;
    return {
      canRead,
      canWrite: canRead && active,
      canManageMembers: false,
      canChangeStatus: canRead,
      canDelete: (isOwner && memberCount < 2) || (admin && !active),
      isOwner,
    };
  }

  const canRead = admin || membership !== null;
  const canWrite = active && (admin || isOwner || membership === 'editor');
  return {
    canRead,
    canWrite,
    canManageMembers: admin || isOwner,
    canChangeStatus: admin || isOwner,
    canDelete: (isOwner && memberCount < 2) || (admin && !active),
    isOwner,
  };
}

/** 비밀번호 정책 판정. 통과하면 빈 배열, 아니면 위반 사유 목록. */
export function checkPasswordPolicy(
  password: string,
  policy: { minLength: number; minCharClasses: number },
): string[] {
  const reasons: string[] = [];
  if (password.length < policy.minLength) reasons.push(`${policy.minLength}자 이상이어야 한다`);
  if (countCharClasses(password) < policy.minCharClasses) reasons.push(`영문 대·소문자, 숫자, 특수문자 중 ${policy.minCharClasses}종 이상`);
  if (/\s/.test(password)) reasons.push('공백을 포함할 수 없다');
  return reasons;
}

export function countCharClasses(password: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
}
