import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from './constants';
import {
  DELEGABLE_ACTIONS,
  DELEGATION,
  can,
  canAssignRole,
  canGrant,
  canManageUser,
  categoryAccess,
  checkPasswordPolicy,
  countCharClasses,
  grantsForRole,
  isAdminRole,
  passwordRuleText,
  spaceAccess,
  suspendProblem,
  unsuspendProblem,
} from './permissions';

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
    // 맡길 수 있는 셋은 받아야 한다 (P15 D.1)
    expect(can(member, 'category.manage')).toBe(false);
    expect(can(member, 'space.unsuspend')).toBe(false);
    expect(can(member, 'space.oversee')).toBe(false);
  });

  it('**관리자와 root는 맡길 수 있는 셋을 역할로 가진다** — 위임 없이 (P15 A.1-2)', () => {
    for (const p of [admin, root]) {
      expect(can(p, 'category.manage')).toBe(true);
      expect(can(p, 'space.unsuspend')).toBe(true);
      expect(can(p, 'space.oversee')).toBe(true);
    }
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

  it('**관리자는 셋을 받은 member도 관리한다** — 셋은 관리자 자신도 가진 권한이라 넘겨받아 얻는 것이 없다 (P15 FR-1604)', () => {
    const delegated = { role: 'member' as const, grants: ['category.manage', 'space.unsuspend', 'space.oversee'] };
    expect(canManageUser(admin, delegated)).toBe(true);
    expect(canManageUser(root, delegated)).toBe(true);
    // 받은 사람은 관리자가 아니다 — 아무도 관리하지 못한다
    expect(canManageUser({ ...member, grants: ['space.oversee'] }, { role: 'member' })).toBe(false);
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

  it('삭제: 생성자는 활성이고 Crew가 본인뿐일 때, 관리자는 중지 상태일 때만', () => {
    expect(spaceAccess(member, team, 'owner', 1).canDelete).toBe(true);
    expect(spaceAccess(member, team, 'owner', 2).canDelete).toBe(false);
    // **'중지'하게 되면 admin만 삭제할 수 있어야 해** (prompts/prototype-v2.md — P14 병합 전 보안 검토 5). 주인은 활성일 때만, 개인 스페이스도
    expect(spaceAccess(member, { ...team, status: 'suspended' }, 'owner', 1).canDelete).toBe(false);
    expect(spaceAccess(member, { ...personal, status: 'suspended' }, 'owner', 0).canDelete).toBe(false);
    expect(spaceAccess(member, personal, 'owner', 0).canDelete).toBe(true);
    expect(spaceAccess(admin, team, null, 5).canDelete).toBe(false);
    expect(spaceAccess(admin, suspendedTeam, null, 5).canDelete).toBe(true);
    expect(spaceAccess(root, suspendedTeam, null, 5).canDelete).toBe(true);
    expect(spaceAccess(other, suspendedTeam, 'editor', 5).canDelete).toBe(false);
  });

  it('비로그인은 전부 거부', () => {
    expect(spaceAccess(null, team, null, 1)).toEqual({
      canRead: false,
      canWrite: false,
      canManageMembers: false,
      canEditInfo: false,
      canChangeStatus: false,
      canDelete: false,
      isOwner: false,
      crewFrozen: false,
    });
  });

  describe('관리자가 건 중지 (P15 C.2, 보류 32)', () => {
    const byOwner = { ...suspendedTeam, suspendedByOwner: true };
    const byAdmin = { ...suspendedTeam, suspendedByOwner: false };
    const personalByAdmin = { ...personal, status: 'suspended' as const, suspendedByOwner: false };

    it('**주인이 건 중지는 주인이 푼다** — 지금처럼', () => {
      expect(spaceAccess(member, byOwner, 'owner', 2).canChangeStatus).toBe(true);
      expect(spaceAccess(member, { ...personal, status: 'suspended', suspendedByOwner: true }, 'owner', 0).canChangeStatus).toBe(true);
    });

    it('**주인이 건 중지도 주인이 아닌 Crew는 못 푼다** — editor·viewer, 관리자가 건 중지 풀기를 받았어도 (병합 전 코드 리뷰 1)', () => {
      for (const role of ['editor', 'viewer'] as const) {
        expect(spaceAccess(other, byOwner, role, 2).canChangeStatus, role).toBe(false);
        expect(spaceAccess({ ...other, grants: ['space.unsuspend'] }, byOwner, role, 2).canChangeStatus, `${role} + 위임`).toBe(false);
      }
      expect(spaceAccess(other, { ...personal, status: 'suspended', suspendedByOwner: true }, null, 0).canChangeStatus).toBe(false);
    });

    it('**관리자가 건 중지는 권한을 받은 주인만 푼다** — 받지 않은 주인은 못 푼다 (FR-1611)', () => {
      expect(spaceAccess(member, byAdmin, 'owner', 2).canChangeStatus).toBe(false);
      expect(spaceAccess(member, personalByAdmin, 'owner', 0).canChangeStatus).toBe(false);
      const unsuspender = { ...member, grants: ['space.unsuspend'] };
      expect(spaceAccess(unsuspender, byAdmin, 'owner', 2).canChangeStatus).toBe(true);
      expect(spaceAccess(unsuspender, personalByAdmin, 'owner', 0).canChangeStatus).toBe(true);
      // 권한을 받아도 주인이 아니면 못 푼다 — 자기 공간만
      expect(spaceAccess({ ...other, grants: ['space.unsuspend'] }, byAdmin, 'editor', 2).canChangeStatus).toBe(false);
    });

    it('**모르면 관리자가 건 것으로 친다** — 적힌 것이 없으면(`suspendedByOwner` 없음) 주인도 권한이 있어야 푼다 (D.2)', () => {
      expect(spaceAccess(member, suspendedTeam, 'owner', 2).canChangeStatus).toBe(false);
    });

    it('**관리자와 스페이스 관리 전체는 언제나 푼다**', () => {
      expect(spaceAccess(admin, byAdmin, null, 2).canChangeStatus).toBe(true);
      expect(spaceAccess(root, byOwner, null, 2).canChangeStatus).toBe(true);
      expect(spaceAccess({ ...other, grants: ['space.oversee'] }, byAdmin, null, 2).canChangeStatus).toBe(true);
    });

    it('활성인 공간의 중지는 주인과 관리자·스페이스 관리 전체가 한다 — editor는 못 한다', () => {
      expect(spaceAccess(member, team, 'owner', 2).canChangeStatus).toBe(true);
      expect(spaceAccess(other, team, 'editor', 2).canChangeStatus).toBe(false);
      expect(spaceAccess({ ...other, grants: ['space.oversee'] }, team, null, 2).canChangeStatus).toBe(true);
    });
  });

  describe('관리자가 건 중지 동안 Crew는 관리자만 바꾼다 (P16 C, 보류 35)', () => {
    const byOwner = { ...suspendedTeam, suspendedByOwner: true };
    const byAdmin = { ...suspendedTeam, suspendedByOwner: false };

    it('**관리자가 건 중지면 주인은 Crew를 바꾸지 못한다** — 만든 사람도 Crew의 owner도, 관리자가 건 중지 풀기를 받았어도 (FR-1700)', () => {
      expect(spaceAccess(member, byAdmin, 'owner', 2).canManageMembers).toBe(false);
      expect(spaceAccess(other, { ...byAdmin, createdBy: 'someone' }, 'owner', 2).canManageMembers).toBe(false);
      expect(spaceAccess({ ...member, grants: ['space.unsuspend'] }, byAdmin, 'owner', 2).canManageMembers).toBe(false);
      // 모르면(적힌 것이 없으면) 관리자가 건 것으로 친다 — 푸는 판정과 같은 기준(P15 D.2)
      expect(spaceAccess(member, suspendedTeam, 'owner', 2).canManageMembers).toBe(false);
    });

    it('**관리자는 언제나 바꾼다** — 관리자가 건 중지에서도 (FR-1701)', () => {
      expect(spaceAccess(admin, byAdmin, null, 2).canManageMembers).toBe(true);
      expect(spaceAccess(root, byAdmin, null, 2).canManageMembers).toBe(true);
    });

    it('**주인이 스스로 건 중지와 활성인 공간은 그대로** — 주인이 바꾼다 (FR-1701)', () => {
      expect(spaceAccess(member, byOwner, 'owner', 2).canManageMembers).toBe(true);
      expect(spaceAccess(member, team, 'owner', 2).canManageMembers).toBe(true);
      expect(spaceAccess(member, { ...team, suspendedByOwner: false }, 'owner', 2).canManageMembers).toBe(true);
    });

    it('스페이스 관리 전체는 Crew를 바꾸지 않는다 — 중지·지우기만 맡겼다. 개인 공간에는 Crew가 없다', () => {
      expect(spaceAccess({ ...other, grants: ['space.oversee'] }, byAdmin, null, 2).canManageMembers).toBe(false);
      expect(spaceAccess({ ...other, grants: ['space.oversee'] }, team, 'editor', 2).canManageMembers).toBe(false);
      expect(spaceAccess(member, { ...personal, status: 'suspended', suspendedByOwner: false }, 'owner', 0).canManageMembers).toBe(false);
    });

    it('**판정의 칸을 다 본다** — 위임 받은 주인은 활성·주인이 건 중지에서 바꾸고, 관리자는 주인이 건 중지·모름에서도 바꾼다. 스페이스 관리 전체를 받은 주인도 관리자가 건 중지면 먼저 푼다 (NFR-160, 병합 전 검토)', () => {
      const unsuspender = { ...member, grants: ['space.unsuspend' as const] };
      const overseer = { ...member, grants: ['space.oversee' as const] };
      expect(spaceAccess(unsuspender, team, 'owner', 2).canManageMembers).toBe(true);
      expect(spaceAccess(unsuspender, byOwner, 'owner', 2).canManageMembers).toBe(true);
      expect(spaceAccess(unsuspender, suspendedTeam, 'owner', 2).canManageMembers).toBe(false);
      expect(spaceAccess(admin, byOwner, null, 2).canManageMembers).toBe(true);
      expect(spaceAccess(admin, suspendedTeam, null, 2).canManageMembers).toBe(true);
      expect(spaceAccess(overseer, byAdmin, 'owner', 2).canManageMembers).toBe(false);
      expect(spaceAccess(overseer, byOwner, 'owner', 2).canManageMembers).toBe(true);
    });

    it('**얼었는지는 판정이 말한다**(`crewFrozen`) — 주인인데 관리자가 건 중지라 Crew를 바꾸지 못할 때만 참이다. 서버의 까닭과 화면의 안내가 이 값 하나를 본다 (FR-1700·1702, 병합 전 코드 리뷰)', () => {
      // 참 — 만든 사람, Crew의 owner, 위임을 받은 주인, 건 사람을 모르는 중지
      expect(spaceAccess(member, byAdmin, 'owner', 2).crewFrozen).toBe(true);
      expect(spaceAccess(other, { ...byAdmin, createdBy: 'someone' }, 'owner', 2).crewFrozen).toBe(true);
      expect(spaceAccess({ ...member, grants: ['space.unsuspend'] }, byAdmin, 'owner', 2).crewFrozen).toBe(true);
      expect(spaceAccess({ ...member, grants: ['space.oversee'] }, byAdmin, 'owner', 2).crewFrozen).toBe(true);
      expect(spaceAccess(member, suspendedTeam, 'owner', 2).crewFrozen).toBe(true);
      // 거짓 — 관리자(주인이어도 바꾼다), 주인이 아닌 사람(원래 못 바꾼다 — 까닭이 다르다), 주인이 건 중지·활성, 개인 공간, 로그인하지 않음
      expect(spaceAccess(admin, byAdmin, 'owner', 2).crewFrozen).toBe(false);
      expect(spaceAccess(root, byAdmin, null, 2).crewFrozen).toBe(false);
      expect(spaceAccess(other, byAdmin, 'editor', 2).crewFrozen).toBe(false);
      expect(spaceAccess({ ...other, grants: ['space.oversee'] }, byAdmin, null, 2).crewFrozen).toBe(false);
      expect(spaceAccess(member, byOwner, 'owner', 2).crewFrozen).toBe(false);
      expect(spaceAccess(member, team, 'owner', 2).crewFrozen).toBe(false);
      expect(spaceAccess(member, { ...personal, status: 'suspended', suspendedByOwner: false }, 'owner', 0).crewFrozen).toBe(false);
      expect(spaceAccess(null, byAdmin, null, 2).crewFrozen).toBe(false);
    });
  });

  describe('스페이스 관리 전체 (P15 C.4, A.1-1)', () => {
    const overseer = { ...other, grants: ['space.oversee'] };

    it('**내용은 읽지 않는다** — Crew가 아닌 팀·남의 개인 공간은 읽지도 쓰지도 Crew를 관리하지도 못한다', () => {
      expect(spaceAccess(overseer, team, null, 3)).toMatchObject({ canRead: false, canWrite: false, canManageMembers: false });
      expect(spaceAccess(overseer, personal, null, 0)).toMatchObject({ canRead: false, canWrite: false });
    });

    it('**중지·다시 쓰기·중지된 것 지우기는 한다**', () => {
      expect(spaceAccess(overseer, team, null, 3)).toMatchObject({ canChangeStatus: true, canDelete: false });
      expect(spaceAccess(overseer, suspendedTeam, null, 3)).toMatchObject({ canChangeStatus: true, canDelete: true });
      expect(spaceAccess(overseer, { ...personal, status: 'suspended' }, null, 0)).toMatchObject({ canChangeStatus: true, canDelete: true });
    });

    it('Crew면 Crew의 자리대로 읽고 쓴다 — 위임이 읽기를 더하지도 빼지도 않는다', () => {
      expect(spaceAccess(overseer, team, 'viewer', 3)).toMatchObject({ canRead: true, canWrite: false });
    });

    it('**이름·설명·분류는 바꾸지 않는다** — editor로 있는 공간도. 중지·다시 쓰기·지우기만 맡겼다 (A.1-1)', () => {
      expect(spaceAccess(overseer, team, 'editor', 3)).toMatchObject({ canWrite: true, canEditInfo: false, canChangeStatus: true });
      expect(spaceAccess(overseer, team, null, 3).canEditInfo).toBe(false);
    });
  });

  describe('이름·설명·분류 바꾸기 (`canEditInfo` — P14 C.2, P15 A.1-1)', () => {
    it('**주인과 관리자만** — editor·viewer·남은 못 한다. 상태와 무관하다(중지된 공간은 쓰기가 막는다)', () => {
      expect(spaceAccess(member, team, 'owner', 3).canEditInfo).toBe(true);
      expect(spaceAccess(member, personal, 'owner', 0).canEditInfo).toBe(true);
      expect(spaceAccess(admin, team, null, 3).canEditInfo).toBe(true);
      expect(spaceAccess(root, personal, null, 0).canEditInfo).toBe(true);
      expect(spaceAccess(other, team, 'editor', 3).canEditInfo).toBe(false);
      expect(spaceAccess(other, team, 'viewer', 3).canEditInfo).toBe(false);
      expect(spaceAccess(other, personal, null, 0).canEditInfo).toBe(false);
      // 중지된 공간 — 칸은 참이고 쓰기가 거짓이다. 서버는 둘을 따로 보고 까닭을 나눠 말한다
      expect(spaceAccess(member, { ...team, status: 'suspended', suspendedByOwner: false }, 'owner', 3)).toMatchObject({ canEditInfo: true, canWrite: false, canChangeStatus: false });
    });

    it('권한을 받은 member도 남의 공간은 못 바꾼다 — 분류 관리·관리자가 건 중지 풀기도 이름을 주지 않는다', () => {
      for (const g of ['category.manage', 'space.unsuspend', 'space.oversee'] as const) {
        expect(spaceAccess({ ...other, grants: [g] }, team, 'editor', 3).canEditInfo).toBe(false);
      }
    });
  });
});

describe('categoryAccess — 분류의 이름 바꾸기·지우기 (P15 C.3, 보류 33)', () => {
  const mine = { createdBy: 'm' };

  it('**만든 사람은 남의 공간이 쓰지 않을 때만** 바꾸고 지운다 — 자기 공간만 쓰면 된다 (FR-1621)', () => {
    expect(categoryAccess(member, mine, { otherSpaces: 0 })).toEqual({ canRename: true, canDelete: true });
    expect(categoryAccess(member, mine, { otherSpaces: 1 })).toEqual({ canRename: false, canDelete: false });
  });

  it('**만들지 않은 member는 못 한다**', () => {
    expect(categoryAccess(other, mine, { otherSpaces: 0 })).toEqual({ canRename: false, canDelete: false });
  });

  it('**관리자와 분류 관리를 받은 사람은 남이 써도 한다**', () => {
    for (const p of [admin, root, { ...other, grants: ['category.manage'] }]) {
      expect(categoryAccess(p, mine, { otherSpaces: 5 })).toEqual({ canRename: true, canDelete: true });
    }
    // 다른 위임은 분류를 주지 않는다
    expect(categoryAccess({ ...other, grants: ['space.oversee'] }, mine, { otherSpaces: 5 })).toEqual({ canRename: false, canDelete: false });
  });

  it('비로그인은 못 한다', () => {
    expect(categoryAccess(null, mine, { otherSpaces: 0 })).toEqual({ canRename: false, canDelete: false });
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

describe('위임 — 규칙표: 받는 역할과 주는 사람 (P11 D.1 · P15 D.1, FR-1600~1605)', () => {
  it('**주는 사람은 그 행위를 스스로 할 수 있다** — 규칙표의 주는 사람(root·admin)이 역할로 가지지 않은 것을 주면 받은 사람을 관리하지 못한다 (병합 전 자체 점검 10)', () => {
    for (const a of DELEGABLE_ACTIONS) {
      expect(can(root, a), `root → ${a}`).toBe(true);
      if (DELEGATION[a].grantor === 'admin') expect(can(admin, a), `admin → ${a}`).toBe(true);
    }
  });

  const granted = { ...admin, grants: ['llm.manage'] };

  it('**규칙표** — LLM 연결 관리는 root가 관리자에게, 셋은 관리자·root가 member에게 (P15 D.1)', () => {
    expect(DELEGABLE_ACTIONS).toEqual(['llm.manage', 'category.manage', 'space.unsuspend', 'space.oversee']);
    expect(DELEGATION).toEqual({
      'llm.manage': { holder: 'admin', grantor: 'root' },
      'category.manage': { holder: 'member', grantor: 'admin' },
      'space.unsuspend': { holder: 'member', grantor: 'admin' },
      'space.oversee': { holder: 'member', grantor: 'admin' },
    });
  });

  it('**root는 LLM 연결 관리를 늘 한다** — 위임 없이. 위임을 주고 거두는 것도 root다', () => {
    expect(can(root, 'llm.manage')).toBe(true);
    expect(can(root, 'user.grants.change')).toBe(true);
  });

  it('**관리자는 위임받았을 때만** LLM 연결 관리를 한다', () => {
    expect(can(admin, 'llm.manage')).toBe(false);
    expect(can({ ...admin, grants: [] }, 'llm.manage')).toBe(false);
    expect(can(granted, 'llm.manage')).toBe(true);
  });

  it('**위임은 받는 역할에게만 먹는다** — LLM 연결 관리는 관리자, 셋은 member. 다른 역할이 목록을 들고 와도 보지 않는다', () => {
    expect(can({ ...member, grants: ['llm.manage'] }, 'llm.manage')).toBe(false);
    expect(can({ ...root, grants: [] }, 'llm.manage')).toBe(true);
    expect(can({ ...member, grants: ['category.manage'] }, 'category.manage')).toBe(true);
    expect(can({ ...member, grants: ['space.unsuspend'] }, 'space.unsuspend')).toBe(true);
    expect(can({ ...member, grants: ['space.oversee'] }, 'space.oversee')).toBe(true);
    // 하나를 받았다고 다른 것이 따라오지 않는다
    expect(can({ ...member, grants: ['space.oversee'] }, 'category.manage')).toBe(false);
    expect(can({ ...member, grants: ['space.oversee'] }, 'space.unsuspend')).toBe(false);
  });

  it('**위임할 수 있는 행위만 먹는다** — 목록에 시스템 관리·위임 바꾸기·스페이스의 내용을 적어 와도 안 된다', () => {
    const forged = { ...member, grants: ['system.manage', 'user.grants.change', 'space.manage', 'category.manage'] };
    expect(can(forged, 'system.manage')).toBe(false);
    expect(can(forged, 'user.grants.change')).toBe(false);
    // 스페이스 관리 전체(`space.oversee`)도 내용을 읽는 `space.manage`가 아니다 (A.1-1)
    expect(can({ ...member, grants: ['space.oversee'] }, 'space.manage')).toBe(false);
    expect(can(forged, 'space.manage')).toBe(false);
    expect(can(forged, 'category.manage')).toBe(true);
  });

  it('**canGrant — 주는 사람과 받는 역할이 표와 맞아야 한다** (A.1-3)', () => {
    // LLM 연결 관리는 root가 관리자에게만
    expect(canGrant(root, 'llm.manage', 'admin')).toBe(true);
    expect(canGrant(granted, 'llm.manage', 'admin')).toBe(false);
    expect(canGrant(admin, 'llm.manage', 'admin')).toBe(false);
    expect(canGrant(root, 'llm.manage', 'member')).toBe(false);
    // 셋은 관리자·root가 member에게만
    for (const a of ['category.manage', 'space.unsuspend', 'space.oversee'] as const) {
      expect(canGrant(admin, a, 'member'), a).toBe(true);
      expect(canGrant(root, a, 'member'), a).toBe(true);
      expect(canGrant(admin, a, 'admin'), a).toBe(false);
      expect(canGrant(root, a, 'root'), a).toBe(false);
      // 받은 사람은 다시 맡기지 못한다
      expect(canGrant({ ...member, grants: [a] }, a, 'member'), a).toBe(false);
    }
    expect(canGrant(null, 'category.manage', 'member')).toBe(false);
  });

  it('**위임을 주고 거두는 창구는 관리자와 root다** — 받은 member는 창구가 없다', () => {
    expect(can(admin, 'user.grants.change')).toBe(true);
    expect(can(granted, 'user.grants.change')).toBe(true);
    expect(can({ ...member, grants: ['space.oversee'] }, 'user.grants.change')).toBe(false);
  });

  it('**grantsForRole — 그 역할이 받을 수 있는 것만 남긴다** (FR-1603). 관리자가 member가 되면 LLM 연결 관리가, member가 관리자가 되면 셋이 사라진다', () => {
    expect(grantsForRole('admin', ['llm.manage'])).toEqual(['llm.manage']);
    expect(grantsForRole('member', ['llm.manage'])).toEqual([]);
    expect(grantsForRole('root', ['llm.manage', 'space.oversee'])).toEqual([]);
    expect(grantsForRole('admin', ['system.manage', 'llm.manage', 'llm.manage', 'space.oversee'])).toEqual(['llm.manage']);
    expect(grantsForRole('member', ['space.oversee', 'category.manage', 'llm.manage', 'category.manage'])).toEqual(['category.manage', 'space.oversee']);
  });
});

/**
 * **계정 정지** (P13 C.5, FR-1441). 관리할 수 있는 사람만(P11의 관리의 우열), 자기 자신과 마지막 활성 root는 못 한다.
 * 정지는 활성 계정만, 해제는 정지 계정만. 문제가 없으면 `null`, 있으면 화면에 보일 까닭을 돌려준다
 */
describe('suspendProblem / unsuspendProblem (P13 FR-1441)', () => {
  const target = (role: 'root' | 'admin' | 'member', status: 'pending' | 'active' | 'suspended' = 'active', id = 't') => ({ id, role, status });

  it('관리할 수 있으면 활성 계정을 정지한다', () => {
    expect(suspendProblem(admin, target('member'), 2)).toBeNull();
    expect(suspendProblem(admin, target('admin'), 2)).toBeNull();
    expect(suspendProblem(root, target('root', 'active', 'r2'), 2)).toBeNull();
  });

  it('관리할 수 없는 사람은 정지하지 못한다 — admin은 root를, member는 아무도', () => {
    expect(suspendProblem(admin, target('root'), 2)).toBe('이 사용자를 관리할 권한이 없다');
    expect(suspendProblem(member, target('member'), 2)).toBe('이 사용자를 관리할 권한이 없다');
  });

  it('위임받은 관리자는 위임 없는 관리자가 정지하지 못한다 (P11 관리의 우열)', () => {
    const delegated = { id: 'd', role: 'admin' as const, status: 'active' as const, grants: ['llm.manage'] };
    expect(suspendProblem(admin, delegated, 2)).toBe('이 사용자를 관리할 권한이 없다');
    expect(suspendProblem(root, delegated, 2)).toBeNull();
  });

  it('자기 자신은 정지하지 못한다', () => {
    expect(suspendProblem(admin, target('admin', 'active', 'a'), 2)).toBe('자기 자신은 정지할 수 없다');
  });

  it('활성 계정만 정지한다 — 승인 대기·이미 정지는 아니다', () => {
    expect(suspendProblem(admin, target('member', 'pending'), 2)).toBe('활성 계정만 정지할 수 있다');
    expect(suspendProblem(admin, target('member', 'suspended'), 2)).toBe('활성 계정만 정지할 수 있다');
  });

  it('**마지막 활성 root는 정지하지 못한다** — 되살릴 사람이 없다', () => {
    expect(suspendProblem(root, target('root', 'active', 'r2'), 1)).toBe('마지막 root는 정지할 수 없다');
  });

  it('해제는 정지된 계정만, 관리할 수 있는 사람만', () => {
    expect(unsuspendProblem(admin, target('member', 'suspended'))).toBeNull();
    expect(unsuspendProblem(admin, target('member', 'active'))).toBe('정지된 계정이 아니다');
    expect(unsuspendProblem(admin, target('root', 'suspended'))).toBe('이 사용자를 관리할 권한이 없다');
  });
});

/**
 * **비밀번호 안내문** (P13 FR-1472). 가입·변경 화면의 안내문이 고정 문자열이라, 관리자가 운영 설정에서 규칙을 바꿔도 따라 바뀌지 않았다.
 * 규칙 값으로 만든다 — 판정(`checkPasswordPolicy`)과 같은 말을 쓴다
 */
describe('passwordRuleText (P13 FR-1472)', () => {
  it('기본 규칙 — 8자·2종', () => {
    expect(passwordRuleText(PASSWORD_POLICY)).toBe('8자 이상, 영문 대·소문자·숫자·특수문자 중 2종 이상, 공백 없이');
  });

  it('**운영이 바꾼 값을 따른다**', () => {
    expect(passwordRuleText({ minLength: 12, minCharClasses: 3 })).toBe('12자 이상, 영문 대·소문자·숫자·특수문자 중 3종 이상, 공백 없이');
  });

  it('종류가 1이면 종류는 말하지 않는다 — 어떤 글자든 된다', () => {
    expect(passwordRuleText({ minLength: 10, minCharClasses: 1 })).toBe('10자 이상, 공백 없이');
  });
});
