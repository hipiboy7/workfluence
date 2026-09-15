import { describe, expect, it } from 'vitest';
import { emptyDocument } from './document';
import {
  createPageDto,
  createSpaceDto,
  createUserDto,
  loginDto,
  movePageDto,
  searchQueryDto,
  updatePageDto,
  updateSpaceDto,
} from './schemas';

const uuid = '0f6b2c1e-6d4a-4c3b-9a8e-1b2c3d4e5f60';

describe('API DTO 스키마', () => {
  it('loginDto: 공백 제거, 빈 값 거부', () => {
    expect(loginDto.parse({ username: '  admin ', password: 'x' })).toEqual({ username: 'admin', password: 'x' });
    expect(loginDto.safeParse({ username: '', password: 'x' }).success).toBe(false);
  });

  it('createUserDto: 사용자명 규칙과 비밀번호 정책을 강제', () => {
    const ok = createUserDto.safeParse({ username: 'hong.gd', displayName: '홍길동', password: 'Str0ng-Passw0rd!', role: 'member' });
    expect(ok.success).toBe(true);
    expect(createUserDto.safeParse({ username: 'Bad Name', displayName: 'x', password: 'Str0ng-Passw0rd!', role: 'member' }).success).toBe(false);
    const weak = createUserDto.safeParse({ username: 'ok', displayName: 'x', password: 'weak', role: 'member' });
    expect(weak.success).toBe(false);
    expect(createUserDto.safeParse({ username: 'ok', displayName: 'x', password: 'Str0ng-Passw0rd!', role: 'root' }).success).toBe(false);
  });

  it('createSpaceDto / updateSpaceDto: 키 규칙, description 기본값', () => {
    expect(createSpaceDto.parse({ key: 'DOCS', name: '문서' })).toEqual({ key: 'DOCS', name: '문서', description: '' });
    expect(createSpaceDto.safeParse({ key: 'docs', name: '문서' }).success).toBe(false);
    expect(createSpaceDto.safeParse({ key: '1ABC', name: '문서' }).success).toBe(false);
    expect(updateSpaceDto.parse({ name: '새 이름' })).toEqual({ name: '새 이름' });
    expect(updateSpaceDto.safeParse({ key: 'X' }).success).toBe(true); // key는 무시된다(omit)
  });

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
