import { describe, expect, it } from 'vitest';
import { DEV_IDENTITY, MockOidcProvider, decodeMockCode, encodeMockCode } from './mock.provider';

describe('모의 OIDC 제공자', () => {
  it('클레임을 code로 싣고 되읽는다', () => {
    const claims = { sub: 's1', preferredUsername: 'u', email: 'e@example.internal', groups: ['g'] };
    expect(decodeMockCode(encodeMockCode(claims))).toEqual(claims);
  });

  it('깨진 code는 개발 기본 신원으로 떨어진다', () => {
    expect(decodeMockCode('!!!not-base64!!!')).toEqual(DEV_IDENTITY);
    expect(decodeMockCode(Buffer.from('{}').toString('base64url'))).toEqual(DEV_IDENTITY);
  });

  it('redirect_uri가 없으면 같은 출처 경로로 되돌린다', async () => {
    const p = new MockOidcProvider({ WF_OIDC_REDIRECT_URI: '' } as never);
    const url = await p.authorizationUrl('st', 'no');
    expect(url.startsWith('/api/auth/oidc/callback?')).toBe(true);
    expect(url).toContain('state=st');
  });

  it('redirect_uri가 있으면 그대로 쓴다', async () => {
    const p = new MockOidcProvider({ WF_OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/oidc/callback' } as never);
    expect(await p.authorizationUrl('st', 'no')).toContain('http://127.0.0.1:3000/api/auth/oidc/callback?');
  });

  it('exchange는 code에 실린 클레임을 그대로 돌려준다', async () => {
    const p = new MockOidcProvider({ WF_OIDC_REDIRECT_URI: '' } as never);
    expect(await p.exchange(encodeMockCode(DEV_IDENTITY), 'n')).toEqual(DEV_IDENTITY);
  });
});
