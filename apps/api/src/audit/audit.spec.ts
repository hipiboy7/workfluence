import { describe, expect, it } from 'vitest';
import { sanitizeDetail } from './audit.module';

/** FR-238 — 감사로그에 비밀이 들어가지 않는 것을 테스트로 고정한다. */
describe('sanitizeDetail', () => {
  it('비밀 계열 키를 통째로 버린다', () => {
    expect(
      sanitizeDetail({
        username: 'alice',
        password: 'p',
        newPassword: 'p',
        temporaryPassword: 'p',
        passwordHash: 'h',
        sessionId: 's',
        sid: 's',
        accessToken: 't',
        idToken: 't',
        clientSecret: 's',
        cookie: 'c',
        authorization: 'a',
      }),
    ).toEqual({ username: 'alice' });
  });

  it('email은 마스킹해서 남긴다', () => {
    expect(sanitizeDetail({ email: 'alice@example.internal' })).toEqual({ email: 'al***@example.internal' });
    expect(sanitizeDetail({ targetEmail: 'bo@example.internal' })).toEqual({ targetEmail: 'bo*@example.internal' });
  });

  it('없으면 null', () => {
    expect(sanitizeDetail(null)).toBeNull();
    expect(sanitizeDetail(undefined)).toBeNull();
  });

  it('그 밖의 값은 그대로', () => {
    expect(sanitizeDetail({ role: 'admin', count: 3, ok: true })).toEqual({ role: 'admin', count: 3, ok: true });
  });
});
