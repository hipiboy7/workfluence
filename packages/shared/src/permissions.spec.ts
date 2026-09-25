import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from './constants';
import { DELEGABLE_ACTIONS, can, canAssignRole, canManageUser, checkPasswordPolicy, countCharClasses, grantsForRole, isAdminRole, spaceAccess } from './permissions';

const root = { id: 'r', role: 'root' as const };
const admin = { id: 'a', role: 'admin' as const };
const member = { id: 'm', role: 'member' as const };
const other = { id: 'o', role: 'member' as const };

describe('can', () => {
  it('root는 시스템 관리를 포함해 전부 허용', () => {
    expect(can(root, 'system.manage')).toBe(true);
    expect(can(root, 'user.manage')).toBe(true);
    expect(can(root, 'space.manage')).toBe(true);
  });

  it('admin은 사용자·스페이스·감사로그·설정 관리는 되지만 시스템 관리는 거부', () => {
    expect(can(admin, 'user.manage')).toBe(true);
    expect(can(admin, 'audit.read')).toBe(true);
    expect(can(admin, 'space.manage')).toBe(true);
    expect(can(admin, 'settings.manage')).toBe(true);
    expect(can(admin, 'system.manage')).toBe(false);
  });

  it('member는 문서 작업·스페이스·카테고리 생성만', () => {
    expect(can(member, 'page.write')).toBe(true);
    expect(can(member, 'space.create')).toBe(true);
    expect(can(member, 'category.create')).toBe(true);
    expect(can(member, 'user.manage')).toBe(false);
    expect(can(member, 'audit.read')).toBe(false);
    expect(can(member, 'space.manage')).toBe(false);
  });

  it('비로그인·알 수 없는 역할은 기본 거부', () => {
    expect(can(null, 'page.read')).toBe(false);
    expect(can(undefined, 'page.read')).toBe(false);
    expect(can({ id: 'x', role: 'ghost' as never }, 'page.read')).toBe(false);
  });

  it('isAdminRole', () => {
    expect(isAdminRole('root')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
  });
});

describe('canAssignRole / canManageUser', () => {
  it('root만 root를 부여하고, admin은 admin·member까지', () => {
    expect(canAssignRole(root, 'root')).toBe(true);
    expect(canAssignRole(admin, 'root')).toBe(false);
    expect(canAssignRole(admin, 'admin')).toBe(true);
    expect(canAssignRole(admin, 'member')).toBe(true);
    expect(canAssignRole(member, 'member')).toBe(false);
  });

  it('admin은 root 계정을 관리할 수 없고 member는 아무도 관리할 수 없다', () => {
    expect(canManageUser(admin, { role: 'root' })).toBe(false);
    expect(canManageUser(admin, { role: 'admin' })).toBe(true);
    expect(canManageUser(admin, { role: 'member' })).toBe(true);
    expect(canManageUser(root, { role: 'root' })).toBe(true);
    expect(canManageUser(member, { role: 'member' })).toBe(false);
  });

  it('**자기에게 없는 위임을 가진 관리자는 관리하지 못한다** — 그 사람의 비밀번호를 초기화해 로그인하면 위임을 얻는다 (P11 보안 검토 1)', () => {
    const delegated = { role: 'admin' as const, grants: ['llm.manage'] };
    expect(canManageUser({ id: 'a2', role: 'admin', grants: [] }, delegated)).toBe(false);
    expect(canManageUser(admin, delegated)).toBe(false);
    // 같은 것을 가진 관리자, root는 관리한다
    expect(canManageUser({ id: 'a3', role: 'admin', grants: ['llm.manage'] }, delegated)).toBe(true);
    expect(canManageUser(root, delegated)).toBe(true);
    // 위임은 관리자만 가진다 — member·root 행의 grants는 보지 않는다(DB도 막는다)
    expect(canManageUser(admin, { role: 'member', grants: ['llm.manage'] })).toBe(true);
    // 위임이 아닌 것을 grants에 적어도 판정이 달라지지 않는다
    expect(canManageUser(admin, { role: 'admin', grants: ['system.manage'] })).toBe(true);
  });
});

describe('spaceAccess', () => {
  const personal = { kind: 'personal' as const, status: 'active' as const, createdBy: 'm' };
  const team = { kind: 'team' as const, status: 'active' as const, createdBy: 'm' };
  const suspendedTeam = { ...team, status: 'suspended' as const };

  it('개인 스페이스는 생성자와 관리자만 보고 쓴다', () => {
    expect(spaceAccess(member, personal, 'owner', 1)).toMatchObject({ canRead: true, canWrite: true, canManageMembers: false, canDelete: true, isOwner: true });
    expect(spaceAccess(other, personal, null, 1)).toEqual(expect.objectContaining({ canRead: false, canWrite: false }));
    expect(spaceAccess(admin, personal, null, 1)).toMatchObject({ canRead: true, canWrite: true, canDelete: false });
    expect(spaceAccess(admin, { ...personal, status: 'suspended' }, null, 1)).toMatchObject({ canRead: true, canWrite: false, canDelete: true });
  });

  it('팀 스페이스는 Crew만 읽고, owner·editor·관리자만 쓴다', () => {
    expect(spaceAccess(other, team, null, 3)).toMatchObject({ canRead: false, canWrite: false });
    expect(spaceAccess(other, team, 'viewer', 3)).toMatchObject({ canRead: true, canWrite: false, canManageMembers: false });
    expect(spaceAccess(other, team, 'editor', 3)).toMatchObject({ canRead: true, canWrite: true, canManageMembers: false, canChangeStatus: false });
    expect(spaceAccess(member, team, 'owner', 3)).toMatchObject({ canRead: true, canWrite: true, canManageMembers: true, canChangeStatus: true, isOwner: true });
    expect(spaceAccess(admin, team, null, 3)).toMatchObject({ canRead: true, canWrite: true, canManageMembers: true, canChangeStatus: true });
  });

  it('중지된 스페이스는 누구도 쓸 수 없다', () => {
    expect(spaceAccess(member, suspendedTeam, 'owner', 1).canWrite).toBe(false);
    expect(spaceAccess(admin, suspendedTeam, null, 1).canWrite).toBe(false);
    expect(spaceAccess(other, suspendedTeam, 'editor', 3).canWrite).toBe(false);
  });

  it('삭제: 생성자는 Crew가 본인뿐일 때, 관리자는 중지 상태일 때만', () => {
    expect(spaceAccess(member, team, 'owner', 1).canDelete).toBe(true);
    expect(spaceAccess(member, team, 'owner', 2).canDelete).toBe(false);
    expect(spaceAccess(admin, team, null, 5).canDelete).toBe(false);
    expect(spaceAccess(admin, suspendedTeam, null, 5).canDelete).toBe(true);
    expect(spaceAccess(root, suspendedTeam, null, 5).canDelete).toBe(true);
    expect(spaceAccess(other, suspendedTeam, 'editor', 5).canDelete).toBe(false);
  });

  it('비로그인은 전부 거부', () => {
    expect(spaceAccess(null, team, null, 1)).toEqual({ canRead: false, canWrite: false, canManageMembers: false, canChangeStatus: false, canDelete: false, isOwner: false });
  });
});

describe('checkPasswordPolicy (8자·2종)', () => {
  it('정책을 통과하는 비밀번호', () => {
    expect(checkPasswordPolicy('abcd1234', PASSWORD_POLICY)).toEqual([]);
    expect(checkPasswordPolicy('Str0ng-Passw0rd!', PASSWORD_POLICY)).toEqual([]);
  });

  it('길이·문자 종류·공백 위반을 각각 보고한다', () => {
    expect(checkPasswordPolicy('short', PASSWORD_POLICY)).toEqual(['8자 이상이어야 한다', '영문 대·소문자, 숫자, 특수문자 중 2종 이상']);
    expect(checkPasswordPolicy('alllowercaseletters', PASSWORD_POLICY)).toEqual(['영문 대·소문자, 숫자, 특수문자 중 2종 이상']);
    expect(checkPasswordPolicy('Has Space 123!', PASSWORD_POLICY)).toEqual(['공백을 포함할 수 없다']);
  });

  it('countCharClasses', () => {
    expect(countCharClasses('abc')).toBe(1);
    expect(countCharClasses('aB1!')).toBe(4);
  });
});

describe('위임 — root가 관리자에게 행위 하나를 준다 (P11 D.1, FR-1200~1206)', () => {
  const granted = { ...admin, grants: ['llm.manage'] };

  it('**root는 LLM 연결 관리를 늘 한다** — 위임 없이. 위임을 주고 거두는 것도 root다', () => {
    expect(can(root, 'llm.manage')).toBe(true);
    expect(can(root, 'user.grants.change')).toBe(true);
  });

  it('**관리자는 위임받았을 때만** LLM 연결 관리를 한다', () => {
    expect(can(admin, 'llm.manage')).toBe(false);
    expect(can({ ...admin, grants: [] }, 'llm.manage')).toBe(false);
    expect(can(granted, 'llm.manage')).toBe(true);
  });

  it('**위임은 관리자에게만 먹는다** — member·root가 위임 목록을 들고 와도 역할만 본다', () => {
    expect(can({ ...member, grants: ['llm.manage'] }, 'llm.manage')).toBe(false);
    expect(can({ ...root, grants: [] }, 'llm.manage')).toBe(true);
  });

  it('**위임할 수 있는 행위만 먹는다** — 목록에 시스템 관리·위임 바꾸기를 적어 와도 안 된다', () => {
    expect(DELEGABLE_ACTIONS).toEqual(['llm.manage']);
    const forged = { ...admin, grants: ['system.manage', 'user.grants.change', 'llm.manage'] };
    expect(can(forged, 'system.manage')).toBe(false);
    expect(can(forged, 'user.grants.change')).toBe(false);
    expect(can(forged, 'llm.manage')).toBe(true);
  });

  it('**위임받은 관리자도 다시 주지 못한다** — 주고 거두는 것은 root만 (A.1-3)', () => {
    expect(can(granted, 'user.grants.change')).toBe(false);
    expect(can(admin, 'user.grants.change')).toBe(false);
  });

  it('**grantsForRole — 관리자가 아니게 되면 위임을 비운다**, 관리자면 위임할 수 있는 것만 남긴다 (A.1-4)', () => {
    expect(grantsForRole('admin', ['llm.manage'])).toEqual(['llm.manage']);
    expect(grantsForRole('member', ['llm.manage'])).toEqual([]);
    expect(grantsForRole('root', ['llm.manage'])).toEqual([]);
    expect(grantsForRole('admin', ['system.manage', 'llm.manage', 'llm.manage'])).toEqual(['llm.manage']);
  });
});

