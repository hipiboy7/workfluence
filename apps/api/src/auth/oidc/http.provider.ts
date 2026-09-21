import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { APP_ENV, type AppEnvToken } from '../../config/config.module';
import type { OidcClaims, OidcProvider, PkcePair } from './oidc.provider';

/**
 * 실제 IdP 제공자 (P1_설계서_Auth 3절, FR-210~214).
 *
 * **이 구현은 실 IdP로 확인되지 않았다** (확인 필요 A). 모의 제공자로 흐름만 검증했고,
 * 실연동은 보류 11이다. 여기 있는 가정 — Discovery 필드 이름, 클레임 이름 — 은
 * 표준을 따랐지만 실제 응답으로 확인한 것이 아니다.
 */

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

@Injectable()
export class HttpOidcProvider implements OidcProvider {
  private discovery?: Promise<Discovery>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(APP_ENV) private readonly env: AppEnvToken) {}

  /**
   * Discovery는 캐시한다. 엔드포인트 URL을 하드코딩하지 않는다 (FR-210).
   *
   * **실패한 Promise는 캐시하지 않는다.** `??=`로 두면 IdP가 잠깐 죽었을 때 거부된 Promise가
   * 영구히 남아, IdP가 복구돼도 앱을 다시 띄우기 전까지 모든 OIDC 로그인이 같은 오류를 낸다.
   */
  private load(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const url = new URL('/.well-known/openid-configuration', this.env.WF_OIDC_ISSUER).toString();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OIDC Discovery 실패: HTTP ${res.status}`);
      const d = (await res.json()) as Discovery;
      for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        if (!d[k]) throw new Error(`OIDC Discovery 응답에 ${k}가 없다`);
      }
      return d;
    })().catch((e: unknown) => {
      this.discovery = undefined;
      throw e;
    });
    return this.discovery;
  }

  async authorizationUrl(state: string, nonce: string, pkce?: PkcePair): Promise<string> {
    const d = await this.load();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.env.WF_OIDC_CLIENT_ID);
    // 설정값을 **그대로** 보낸다. 요청 헤더로 조립하면 Host 헤더 조작에 끌려간다 (FR-214)
    u.searchParams.set('redirect_uri', this.env.WF_OIDC_REDIRECT_URI);
    u.searchParams.set('scope', 'openid profile email groups');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    if (pkce) {
      u.searchParams.set('code_challenge', pkce.challenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
    return u.toString();
  }

  async exchange(code: string, nonce: string, verifier?: string): Promise<OidcClaims> {
    const d = await this.load();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.env.WF_OIDC_REDIRECT_URI,
      client_id: this.env.WF_OIDC_CLIENT_ID,
      client_secret: this.env.WF_OIDC_CLIENT_SECRET,
    });
    if (verifier) body.set('code_verifier', verifier);

    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new UnauthorizedException(`토큰 교환 실패: HTTP ${res.status}`);
    const token = (await res.json()) as { id_token?: string };
    if (!token.id_token) throw new UnauthorizedException('응답에 id_token이 없다');

    // JWKS는 jose가 kid별로 캐시하고, 모르는 kid면 한 번 다시 받는다 (FR-213)
    this.jwks ??= createRemoteJWKSet(new URL(d.jwks_uri));
    const { payload } = await jwtVerify(token.id_token, this.jwks, {
      issuer: d.issuer,
      audience: this.env.WF_OIDC_CLIENT_ID,
      algorithms: ['RS256'],
    });
    // nonce 대조는 jwtVerify가 해 주지 않는다. 직접 본다 (FR-211)
    if (payload.nonce !== nonce) throw new UnauthorizedException('nonce가 일치하지 않는다');
    if (typeof payload.sub !== 'string' || !payload.sub) throw new UnauthorizedException('sub가 없다');

    return {
      sub: payload.sub,
      preferredUsername: typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      groups: payload.groups,
    };
  }
}
