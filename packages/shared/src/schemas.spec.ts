import { describe, expect, it } from 'vitest';
import { emptyDocument } from './document';
import {
  addMemberDto,
  changePasswordDto,
  createCategoryDto,
  createPageDto,
  createSpaceDto,
  createUserDto,
  findIdDto,
  loginDto,
  movePageDto,
  recoverPasswordDto,
  searchQueryDto,
  signupDto,
  spaceListQueryDto,
  spaceStatusDto,
  updatePageDto,
  updateSpaceDto,
} from './schemas';

const uuid = '0f6b2c1e-6d4a-4c3b-9a8e-1b2c3d4e5f60';

describe('인증·계정 DTO', () => {
  it('loginDto: 공백 제거, 빈 값 거부', () => {
    expect(loginDto.parse({ username: '  admin ', password: 'x' })).toEqual({ username: 'admin', password: 'x' });
    expect(loginDto.safeParse({ username: '', password: 'x' }).success).toBe(false);
  });

  it('signupDto: 사용자명 규칙, email 정규화, 비밀번호는 **바닥(8자)만** 계약이 본다', () => {
    const ok = signupDto.parse({ username: 'hong.gd', displayName: '홍길동', email: ' Hong.GD@Example.Internal ', password: 'abcd1234' });
    expect(ok.email).toBe('hong.gd@example.internal');
    expect(signupDto.safeParse({ username: 'Bad Name', displayName: 'x', email: 'a@b.co', password: 'abcd1234' }).success).toBe(false);
    expect(signupDto.safeParse({ username: 'ok', displayName: 'x', email: 'not-an-email', password: 'abcd1234' }).success).toBe(false);
    // 8자·1종은 **계약을 통과한다.** 문자 종류는 운영이 조절하는 값이라 서비스가
    // 살아 있는 정책값으로 본다 — 여기서 굳히면 관리자가 낮춰도 영영 안 먹는다 (P4 자체 점검 2)
    expect(signupDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abcdefgh' }).success).toBe(true);
    // 바닥은 계약이 막는다
    const short = signupDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abc1' });
    expect(short.success).toBe(false);
    if (!short.success) expect(short.error.issues.map((i) => i.message)).toContain('8자 이상');
  });

  it('findIdDto는 email과 이름을 둘 다 요구한다', () => {
    expect(findIdDto.safeParse({ email: 'a@b.co' }).success).toBe(false);
    expect(findIdDto.safeParse({ email: 'a@b.co', displayName: '홍길동' }).success).toBe(true);
  });

  it('recoverPasswordDto / changePasswordDto', () => {
    expect(recoverPasswordDto.safeParse({ username: 'hong', email: 'a@b.co' }).success).toBe(true);
    expect(changePasswordDto.safeParse({ currentPassword: 'old-pass1', newPassword: 'new-pass1' }).success).toBe(true);
    expect(changePasswordDto.safeParse({ currentPassword: 'same-pass1', newPassword: 'same-pass1' }).success).toBe(false);
    expect(changePasswordDto.safeParse({ currentPassword: 'old', newPassword: 'short' }).success).toBe(false);
  });

  it('createUserDto: 역할은 root·admin·member', () => {
    expect(createUserDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abcd1234', role: 'admin' }).success).toBe(true);
    expect(createUserDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abcd1234', role: 'superuser' }).success).toBe(false);
  });
});

describe('카테고리·스페이스 DTO', () => {
  it('createCategoryDto', () => {
    expect(createCategoryDto.parse({ name: ' 운영 ' })).toEqual({ name: '운영' });
    expect(createCategoryDto.safeParse({ name: '' }).success).toBe(false);
  });

  it('createSpaceDto: 종류 필수, 카테고리 선택, description 기본값', () => {
    expect(createSpaceDto.parse({ name: '문서', kind: 'team', categoryId: uuid })).toEqual({ name: '문서', kind: 'team', categoryId: uuid, description: '' });
    expect(createSpaceDto.parse({ name: '내 공간', kind: 'personal' }).categoryId).toBeNull();
    expect(createSpaceDto.safeParse({ name: '문서', kind: 'group' }).success).toBe(false);
    expect(createSpaceDto.safeParse({ name: '문서', kind: 'team', categoryId: 'nope' }).success).toBe(false);
  });

  it('updateSpaceDto / spaceStatusDto / addMemberDto / spaceListQueryDto', () => {
    expect(updateSpaceDto.parse({ name: '새 이름' })).toEqual({ name: '새 이름' });
    expect(spaceStatusDto.safeParse({ status: 'suspended' }).success).toBe(true);
    expect(spaceStatusDto.safeParse({ status: 'deleted' }).success).toBe(false);
    expect(addMemberDto.safeParse({ username: 'kim', role: 'viewer' }).success).toBe(true);
    expect(addMemberDto.safeParse({ username: 'kim', role: 'owner' }).success).toBe(false);
    expect(spaceListQueryDto.parse({})).toEqual({ scope: 'personal', limit: 200 });
    expect(spaceListQueryDto.parse({ scope: 'all', limit: '5' })).toEqual({ scope: 'all', limit: 5 });
  });
});

describe('페이지·검색 DTO', () => {
  it('createPageDto: 본문을 문서 검증기로 검사하고 parentId 기본값은 null', () => {
    const ok = createPageDto.parse({ spaceId: uuid, title: '제목', content: emptyDocument() });
    expect(ok.parentId).toBeNull();
    const bad = createPageDto.safeParse({ spaceId: uuid, title: '제목', content: { type: 'doc', content: [{ type: 'script' }] } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toContain('본문 검증 실패');
    expect(createPageDto.safeParse({ spaceId: 'not-uuid', title: '제목', content: emptyDocument() }).success).toBe(false);
  });

  it('updatePageDto: baseVersionNo는 양의 정수', () => {
    expect(updatePageDto.safeParse({ title: 't', content: emptyDocument(), baseVersionNo: 3 }).success).toBe(true);
    expect(updatePageDto.safeParse({ title: 't', content: emptyDocument(), baseVersionNo: 0 }).success).toBe(false);
    expect(updatePageDto.safeParse({ title: 't', content: emptyDocument() }).success).toBe(false);
  });

  it('movePageDto / searchQueryDto', () => {
    expect(movePageDto.parse({ parentId: null, position: 0 })).toEqual({ parentId: null, position: 0 });
    expect(movePageDto.safeParse({ parentId: uuid, position: -1 }).success).toBe(false);
    expect(searchQueryDto.parse({ q: ' 배포 ' })).toEqual({ q: '배포', limit: 20 });
    expect(searchQueryDto.parse({ q: 'x', limit: '5' }).limit).toBe(5);
    expect(searchQueryDto.safeParse({ q: 'x', limit: '500' }).success).toBe(false);
  });
});
