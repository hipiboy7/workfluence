import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from './constants';
import { can, checkPasswordPolicy } from './permissions';

describe('can', () => {
  const admin = { id: 'a', role: 'admin' as const };
  const member = { id: 'm', role: 'member' as const };

  it('admin은 사용자 관리·감사로그를 포함해 전부 허용', () => {
    expect(can(admin, 'user.manage')).toBe(true);
    expect(can(admin, 'audit.read')).toBe(true);
    expect(can(admin, 'space.delete')).toBe(true);
  });

  it('member는 문서 작업만, 관리 기능은 거부', () => {
    expect(can(member, 'page.write')).toBe(true);
    expect(can(member, 'space.create')).toBe(true);
    expect(can(member, 'user.manage')).toBe(false);
    expect(can(member, 'audit.read')).toBe(false);
    expect(can(member, 'space.delete')).toBe(false);
  });

  it('비로그인·알 수 없는 역할은 기본 거부', () => {
    expect(can(null, 'page.read')).toBe(false);
    expect(can(undefined, 'page.read')).toBe(false);
    expect(can({ id: 'x', role: 'ghost' as never }, 'page.read')).toBe(false);
  });
});

describe('checkPasswordPolicy', () => {
  it('기본 정책(12자·3종)을 통과하는 비밀번호', () => {
    expect(checkPasswordPolicy('Str0ng-Passw0rd!', PASSWORD_POLICY)).toEqual([]);
  });

  it('길이·문자 종류·공백 위반을 각각 보고한다', () => {
    expect(checkPasswordPolicy('short', PASSWORD_POLICY)).toEqual(['12자 이상이어야 한다', '영문 대·소문자, 숫자, 특수문자 중 3종 이상']);
    expect(checkPasswordPolicy('alllowercaseletters', PASSWORD_POLICY)).toEqual(['영문 대·소문자, 숫자, 특수문자 중 3종 이상']);
    expect(checkPasswordPolicy('Has Space 123!', PASSWORD_POLICY)).toEqual(['공백을 포함할 수 없다']);
  });
});
