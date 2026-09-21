import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, type AppEnvToken } from '../../config/config.module';
import type { OidcClaims, OidcProvider, PkcePair } from './oidc.provider';

/**
 * 모의 OIDC 제공자 (P1_설계서_Auth 3.2절).
 *
 * 개발 서버가 사내 IdP에 못 나갈 수 있어서(확인 필요 A) 만든다. 인가 화면 대신
 * **콜백으로 바로 돌려보내고**, `code`에 클레임을 실어 보낸다. 그래서 테스트가
 * "IdP가 이런 클레임을 주면"을 자유롭게 바꿔 가며 확인할 수 있다.
 *
 * 이 제공자로 검증되는 것: state·nonce 대조, 클레임→역할 매핑, JIT 생성·갱신, 거부 경로.
 * 검증되지 **않는** 것: 실 IdP가 실제로 무엇을 주는가. 그것은 완료 기준에서 뺐다.
 *
 * `WF_ENV=production`에서는 환경 스키마가 이 제공자를 아예 거부한다 (env.ts).
 */

export const DEV_IDENTITY: OidcClaims = {
  sub: 'mock-sub-dev',
  preferredUsername: 'idp.dev',
  email: 'idp.dev@example.internal',
  groups: ['wf-users'],
};

export function encodeMockCode(claims: OidcClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

export function decodeMockCode(code: string): OidcClaims {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as OidcClaims).sub === 'string') return parsed as OidcClaims;
  } catch {
    /* 아래에서 기본값을 쓴다 */
  }
  return DEV_IDENTITY;
}

@Injectable()
export class MockOidcProvider implements OidcProvider {
  constructor(@Inject(APP_ENV) private readonly env: AppEnvToken) {}

  authorizationUrl(state: string, _nonce: string, _pkce?: PkcePair): Promise<string> {
    const redirect = this.env.WF_OIDC_REDIRECT_URI || '/api/auth/oidc/callback';
    const url = new URL(redirect, 'http://127.0.0.1');
    url.searchParams.set('code', encodeMockCode(DEV_IDENTITY));
    url.searchParams.set('state', state);
    // 절대 URI가 설정돼 있으면 그대로, 아니면 경로만 (같은 출처로 되돌린다)
    return Promise.resolve(this.env.WF_OIDC_REDIRECT_URI ? url.toString() : `${url.pathname}${url.search}`);
  }

  exchange(code: string, _nonce: string, _verifier?: string): Promise<OidcClaims> {
    return Promise.resolve(decodeMockCode(code));
  }
}
