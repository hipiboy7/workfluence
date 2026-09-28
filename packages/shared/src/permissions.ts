import type { Role, SpaceKind, SpaceMemberRole, SpaceStatus, UserStatus } from './constants';

/**
 * 권한 판정 순수 함수 (CLAUDE.md 7절 "권한 판정은 shared 순수 함수로 한 곳에서").
 * - can(): 시스템 역할 기준의 거친 판정 (가드에서 사용)
 * - spaceAccess(): 스페이스 단위 판정 (서비스에서 사용)
 * - canAssignRole() / canManageUser(): 사용자 관리 시 역할 간 우열
 */

export type Principal = {
  id: string;
  role: Role;
  /**
   * 맡겨 받은 행위 (P11_설계서_Ops D.1 · P15_설계서_Grants D.1). **규칙표의 받는 역할일 때만 먹는다** — 다른 역할이면 보지 않는다. 가드가
   * 요청마다 사용자 행에서 싣는다 — 받거나 잃으면 다음 요청부터다
   */
  grants?: readonly string[];
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
  | 'page.delete'
  | 'llm.manage' // 사내 LLM 연결 관리 — root, 그리고 root가 위임한 admin (P11 D.1)
  | 'category.manage' // 남이 쓰는 분류도 이름을 바꾸고 지운다 — 관리자, 그리고 관리자가 맡긴 member (P15 D.1)
  | 'space.unsuspend' // 관리자가 건 중지를 자기 공간에서 푼다 — 관리자, 그리고 관리자가 맡긴 member (P15 C.2)
  | 'space.oversee' // 모든 공간의 목록·중지·다시 쓰기·지우기 — 내용은 읽지 않는다(`space.manage`와 다르다, P15 A.1-1)
  | 'user.grants.change'; // 위임을 주고 거두는 창구 — root와 관리자. 무엇을 줄 수 있는지는 규칙표(`DELEGATION`)가 정한다 (P15 D.1)

/**
 * **위임할 수 있는 행위** (P11 D.1 · P15 D.1). 여기 없는 행위는 위임 목록에 적혀 있어도 먹지 않는다. 더하면 규칙표(`DELEGATION`)에 칸을
 * 두고, 마이그레이션의 CHECK(`users_grants_known_chk`·`users_grants_holder_chk`)도 고친다 — `constraints.integration.spec.ts`가 본다
 */
export const DELEGABLE_ACTIONS = ['llm.manage', 'category.manage', 'space.unsuspend', 'space.oversee'] as const satisfies readonly Action[];
export type DelegableAction = (typeof DELEGABLE_ACTIONS)[number];
const DELEGABLE: ReadonlySet<string> = new Set(DELEGABLE_ACTIONS);

/**
 * **위임 규칙표** — 행위마다 **받는 역할**(`holder`)과 **주는 사람**(`grantor`)이 하나씩이다 (P15 D.1, NFR-150).
 * - LLM 연결 관리는 root가 관리자에게 준다(P11). 관리자가 아니게 되면 사라진다
 * - 셋은 관리자·root가 **member에게** 준다 — 관리자·root는 역할로 이미 가진다(A.1-2). member가 관리자가 되면 역할에 든다
 * - 받은 사람은 다시 주지 못한다 — 창구(`user.grants.change`)는 역할만 가진다(A.1-3)
 */
export const DELEGATION: Readonly<Record<DelegableAction, { holder: Role; grantor: 'root' | 'admin' }>> = {
  'llm.manage': { holder: 'admin', grantor: 'root' },
  'category.manage': { holder: 'member', grantor: 'admin' },
  'space.unsuspend': { holder: 'member', grantor: 'admin' },
  'space.oversee': { holder: 'member', grantor: 'admin' },
};

function isDelegable(action: string): action is DelegableAction {
  return DELEGABLE.has(action);
}

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
    'llm.manage',
    'category.manage',
    'space.unsuspend',
    'space.oversee',
    'user.grants.change',
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
    'category.manage',
    'space.unsuspend',
    'space.oversee',
    'user.grants.change',
  ]),
  member: new Set<Action>(['space.create', 'category.create', 'page.read', 'page.write', 'page.delete']),
};

export function can(principal: Principal | null | undefined, action: Action): boolean {
  if (!principal) return false;
  const byRole = GRANTS[principal.role];
  if (!byRole) return false;
  if (byRole.has(action)) return true;
  // 위임 — 위임할 수 있는 행위이고, 그 사람이 규칙표의 받는 역할이고, 받은 것일 때만 (P11 D.1 · P15 D.1)
  return isDelegable(action) && DELEGATION[action].holder === principal.role && (principal.grants ?? []).includes(action);
}

/**
 * 역할에 맞는 위임 목록 — **그 역할이 받을 수 있는 것만** 겹치지 않게 남긴다(FR-1603). 관리자가 member가 되면 LLM 연결 관리가, member가
 * 관리자가 되면 셋이 사라진다(역할에 든다). 역할이 바뀌는 자리(관리 화면·사내 계정 동기화)가 이것으로 새 목록을 정한다
 */
export function grantsForRole(role: Role, grants: readonly string[]): DelegableAction[] {
  return DELEGABLE_ACTIONS.filter((a) => DELEGATION[a].holder === role && grants.includes(a));
}

/**
 * **actor가 그 위임을 주고 거둘 수 있는가** (P15 D.1, A.1-3). 창구(`user.grants.change`)가 있어야 하고, 규칙표의 주는 사람이어야 하고
 * (root면 root만, admin이면 관리자와 root), 대상의 역할이 받는 역할이어야 한다. 받은 사람은 창구가 없어 다시 주지 못한다
 */
export function canGrant(actor: Principal | null | undefined, action: DelegableAction, targetRole: Role): boolean {
  if (!actor || !can(actor, 'user.grants.change')) return false;
  const rule = DELEGATION[action];
  if (rule.holder !== targetRole) return false;
  return rule.grantor === 'root' ? actor.role === 'root' : isAdminRole(actor.role);
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

/**
 * actor가 target 사용자를 관리(승인·초기화·잠금 해제·역할 변경·세션 종료)할 수 있는가. admin은 root를 건드릴 수 없다.
 *
 * **자기가 할 수 없는 위임을 가진 사람은 건드릴 수 없다** (P11 보안 검토 1). 위임 없는 관리자가 위임받은 관리자의 비밀번호를 초기화하면
 * 그 계정으로 로그인해 위임을 얻고, 역할을 내렸다 올리면 root가 맡긴 것을 거둔다. 역할의 우열과 같이 **가진 것의 우열**을 본다 — 대상이 가진
 * 위임(그 역할이 받을 수 있는 것만 — `grantsForRole`)을 actor가 **모두 할 수 있어야** 한다(`can`). 관리자는 셋을 역할로 가지므로 셋을
 * 받은 member를 관리한다(P15 FR-1604). root는 모두를 관리한다
 */
export function canManageUser(actor: Principal, target: { role: Role; grants?: readonly string[] }): boolean {
  if (!isAdminRole(actor.role)) return false;
  if (ROLE_RANK[actor.role] < ROLE_RANK[target.role]) return false;
  if (actor.role === 'root') return true;
  return grantsForRole(target.role, target.grants ?? []).every((g) => can(actor, g));
}

/** 정지·해제의 대상 (P13 C.5) */
export type UserTarget = { id: string; role: Role; status: UserStatus; grants?: readonly string[] };

/**
 * **정지할 수 없는 까닭** (P13 FR-1441). 없으면 `null`. 관리할 수 있는 사람만(P11 관리의 우열 — `canManageUser`), 자기 자신은 못 한다
 * (스스로 잠그면 되살릴 길이 다른 사람뿐이다), 활성 계정만, **마지막 활성 root는 못 한다** — 되살릴 사람이 없다. `activeRoots`는
 * 대상을 포함한 활성 root의 수다. 호출부는 그 수를 **판정한 행을 잠근 채** 센다(P11 마지막 root 강등과 같은 경합)
 */
export function suspendProblem(actor: Principal, target: UserTarget, activeRoots: number): string | null {
  if (!canManageUser(actor, target)) return '이 사용자를 관리할 권한이 없다';
  if (actor.id === target.id) return '자기 자신은 정지할 수 없다';
  if (target.status !== 'active') return '활성 계정만 정지할 수 있다';
  if (target.role === 'root' && activeRoots <= 1) return '마지막 root는 정지할 수 없다';
  return null;
}

/** **정지를 풀 수 없는 까닭** (P13 FR-1441). 해제하면 활성으로 돌아간다 */
export function unsuspendProblem(actor: Principal, target: UserTarget): string | null {
  if (!canManageUser(actor, target)) return '이 사용자를 관리할 권한이 없다';
  if (target.status !== 'suspended') return '정지된 계정이 아니다';
  return null;
}

export type SpaceLike = {
  kind: SpaceKind;
  status: SpaceStatus;
  createdBy: string;
  /**
   * 중지를 건 사람이 그 공간의 주인이었는가 (P15 D.2, `spaces.suspended_by_owner`). 중지일 때만 뜻이 있다. **모르면(없으면) 관리자가 건
   * 것으로 친다** — 주인도 권한(`space.unsuspend`)이 있어야 푼다
   */
  suspendedByOwner?: boolean;
};

export type SpaceAccess = {
  canRead: boolean;
  canWrite: boolean;
  canManageMembers: boolean;
  /** 이름·설명·분류를 바꾸는가 — 주인과 관리자. 상태는 보지 않는다(중지된 공간은 `canWrite`가 막는다 — 서버가 까닭을 나눠 말한다) */
  canEditInfo: boolean;
  canChangeStatus: boolean;
  canDelete: boolean;
  isOwner: boolean;
};

const NO_ACCESS: SpaceAccess = {
  canRead: false,
  canWrite: false,
  canManageMembers: false,
  canEditInfo: false,
  canChangeStatus: false,
  canDelete: false,
  isOwner: false,
};

/**
 * 스페이스 접근 판정 (docs/prompts/prototype-v2.md 2절 7·8·11번).
 * - 개인: 생성자와 관리자만. Crew 없음.
 * - 팀: Crew(owner·editor·viewer)만 읽기. owner·editor·관리자만 쓰기.
 * - 중지 상태: 누구도 쓰기 불가(읽기 전용).
 * - 삭제: 생성자는 Crew가 본인뿐(memberCount < 2)이고 **활성일 때**, 관리자는 중지 상태일 때. 원문 "'중지'하게되면, admin만 삭제할 수
 *   있어야해" — 처음 판은 활성 조건을 빠뜨려 중지된 스페이스를 주인이 지울 수 있었다(P14 병합 전 보안 검토 5).
 * - `canChangeStatus`는 **지금 상태에서 바꿀 수 있는가**다 (P15 D.3). 활성이면 중지 — 주인과 `space.oversee`(관리자·root·스페이스 관리
 *   전체). 중지면 다시 쓰기 — `space.oversee`, 그리고 주인이 건 중지면 주인, **관리자가 건 중지면 `space.unsuspend`를 받은 주인만**(보류 32).
 *   중지된 것 지우기도 `space.oversee`다. **읽기·쓰기·Crew 관리·이름 바꾸기는 관리자 역할과 Crew로만 정한다** — 스페이스 관리 전체는 내용을
 *   읽지 않고 이름도 바꾸지 않는다(A.1-1). 이름·설명·분류는 `canEditInfo`(주인과 관리자)다 — 예전에는 `canChangeStatus`를 빌려 썼다
 */
export function spaceAccess(
  principal: Principal | null | undefined,
  space: SpaceLike,
  membership: SpaceMemberRole | null,
  memberCount: number,
): SpaceAccess {
  if (!principal) return NO_ACCESS;
  const admin = isAdminRole(principal.role);
  const overseer = can(principal, 'space.oversee');
  const isOwner = space.createdBy === principal.id || membership === 'owner';
  const active = space.status === 'active';
  const canResume = overseer || (isOwner && (space.suspendedByOwner === true || can(principal, 'space.unsuspend')));
  const canChangeStatus = active ? overseer || isOwner : canResume;
  const canDelete = (isOwner && memberCount < 2 && active) || (overseer && !active);
  const canEditInfo = admin || isOwner;

  if (space.kind === 'personal') {
    const canRead = isOwner || admin;
    return { canRead, canWrite: canRead && active, canManageMembers: false, canEditInfo, canChangeStatus, canDelete, isOwner };
  }

  const canRead = admin || membership !== null;
  const canWrite = active && (admin || isOwner || membership === 'editor');
  return { canRead, canWrite, canManageMembers: admin || isOwner, canEditInfo, canChangeStatus, canDelete, isOwner };
}

export type CategoryAccess = { canRename: boolean; canDelete: boolean };

/**
 * **분류의 이름 바꾸기·지우기** (P15 D.4, FR-1621 — 보류 33). 관리자와 분류 관리(`category.manage`)를 받은 사람은 늘 한다. 만든 사람은
 * **남의 공간이 쓰지 않을 때만** 한다 — 자기 공간만 쓰면 된다(그 공간들이 분류 없음이 된다). 남의 공간은 분류를 만든 사람이 주인이 아닌
 * 공간이다(휴지통 포함 — 호출부가 센다). 이름 바꾸기도 같은 규칙이다(A.1-7)
 */
export function categoryAccess(principal: Principal | null | undefined, category: { createdBy: string }, usage: { otherSpaces: number }): CategoryAccess {
  if (!principal) return { canRename: false, canDelete: false };
  const ok = can(principal, 'category.manage') || (category.createdBy === principal.id && usage.otherSpaces === 0);
  return { canRename: ok, canDelete: ok };
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

/**
 * **비밀번호 안내문** (P13 FR-1472) — 규칙 값으로 만든다. 가입·변경 화면의 안내문이 고정 문자열이라 관리자가 운영 설정에서 규칙을 바꿔도
 * 따라 바뀌지 않았다. 판정(`checkPasswordPolicy`)과 같은 말을 쓴다
 */
export function passwordRuleText(policy: { minLength: number; minCharClasses: number }): string {
  const parts = [`${policy.minLength}자 이상`];
  if (policy.minCharClasses > 1) parts.push(`영문 대·소문자·숫자·특수문자 중 ${policy.minCharClasses}종 이상`);
  parts.push('공백 없이');
  return parts.join(', ');
}

export function countCharClasses(password: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
}
