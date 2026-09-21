import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, EnvValidationError, extractEnvExampleKeys, parseEnv } from './env';

/** 필수 키 최소 집합. Phase 1에서 세션 서명 키와 최초 계정 비밀번호가 필수로 늘었다. */
const valid = {
  WF_DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/db',
  WF_SESSION_SECRET: 's'.repeat(32),
  WF_ROOT_PASSWORD: 'root-initial-password',
};

describe('parseEnv', () => {
  it('WF_ 키만 골라 파싱하고 기본값을 채운다', () => {
    const env = parseEnv({ ...valid, PATH: '/usr/bin', HOME: '/home' });
    expect(env.WF_ENV).toBe('development');
    expect(env.WF_PORT).toBe(3000);
    expect(env.WF_DB_AUTO_MIGRATE).toBe(false);
    expect(env.WF_PG_EMBEDDED_PORT).toBe(5433);
    expect(env.WF_WEB_DIST).toBe('../web/dist');
  });

  it('스키마에 없는 WF_ 키는 기동 실패 (미배선·오타 키 차단)', () => {
    expect(() => parseEnv({ ...valid, WF_TYPO: '1' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, WF_TYPO: '1' })).toThrow(/WF_TYPO/);
  });

  it('타입·범위가 틀리면 기동 실패', () => {
    expect(() => parseEnv({ ...valid, WF_PORT: 'abc' })).toThrow(/WF_PORT/);
    expect(() => parseEnv({ ...valid, WF_PORT: '70000' })).toThrow(/WF_PORT/);
    expect(() => parseEnv({ ...valid, WF_PG_EMBEDDED_PORT: '80' })).toThrow(/WF_PG_EMBEDDED_PORT/);
    expect(() => parseEnv({ ...valid, WF_TRUST_PROXY: 'yes' })).toThrow(/WF_TRUST_PROXY/);
    expect(() => parseEnv({ ...valid, WF_DATABASE_URL: 'not-a-url' })).toThrow(/WF_DATABASE_URL/);
    expect(() => parseEnv({})).toThrow(/WF_DATABASE_URL/);
    // 세션 서명 키가 짧으면 기동 실패 — 짧은 키는 서명을 못 지킨다
    expect(() => parseEnv({ ...valid, WF_SESSION_SECRET: 'short' })).toThrow(/WF_SESSION_SECRET/);
  });

  it('빈 문자열 값은 미설정으로 취급해 기본값을 쓴다', () => {
    expect(parseEnv({ ...valid, WF_PORT: '' }).WF_PORT).toBe(3000);
  });

  it('운영에서 자동 마이그레이션은 금지', () => {
    expect(() => parseEnv({ ...valid, WF_ENV: 'production', WF_DB_AUTO_MIGRATE: 'true' })).toThrow(/production/);
    expect(parseEnv({ ...valid, WF_ENV: 'production', WF_DB_AUTO_MIGRATE: 'false' }).WF_ENV).toBe('production');
  });

  it('불리언·정수 변환', () => {
    const env = parseEnv({ ...valid, WF_SERVE_WEB: 'true', WF_TRUST_PROXY: 'false', WF_PORT: '8080' });
    expect(env.WF_SERVE_WEB).toBe(true);
    expect(env.WF_TRUST_PROXY).toBe(false);
    expect(env.WF_PORT).toBe(8080);
  });
});

describe('Phase 1 — 세션·OIDC 규칙 (P1_설계서_Auth 9절)', () => {
  it('모의 OIDC는 운영에서 거부한다 — 조용히 잘못되는 유형이다', () => {
    expect(() => parseEnv({ ...valid, WF_ENV: 'production', WF_OIDC_MOCK: 'true' })).toThrow(/WF_OIDC_MOCK/);
    expect(parseEnv({ ...valid, WF_ENV: 'development', WF_OIDC_MOCK: 'true' }).WF_OIDC_MOCK).toBe(true);
  });

  it('OIDC를 켜 놓고 값을 비우면 기동 실패 (FR-219)', () => {
    // 켜져 있는데 값이 없으면 "버튼은 있는데 눌러도 안 되는" 상태가 된다
    expect(() => parseEnv({ ...valid, WF_OIDC_ENABLED: 'true' })).toThrow(/WF_OIDC_ISSUER/);
    const ok = parseEnv({
      ...valid,
      WF_OIDC_ENABLED: 'true',
      WF_OIDC_ISSUER: 'https://idp.example.internal',
      WF_OIDC_CLIENT_ID: 'wf',
      WF_OIDC_CLIENT_SECRET: 'secret',
      WF_OIDC_REDIRECT_URI: 'https://wf.example.internal/api/auth/oidc/callback',
      WF_OIDC_ROLE_MAP: '{"g":"member"}',
    });
    expect(ok.WF_OIDC_ENABLED).toBe(true);
    expect(ok.WF_OIDC_PKCE).toBe(true);
  });

  it('모의 제공자를 쓰면 IdP 값은 없어도 된다', () => {
    const env = parseEnv({ ...valid, WF_OIDC_ENABLED: 'true', WF_OIDC_MOCK: 'true' });
    expect(env.WF_OIDC_MOCK).toBe(true);
  });

  it('역할 맵이 비어 있으면 모든 IdP 사용자가 거부되므로 기동 실패 (FR-218)', () => {
    expect(() =>
      parseEnv({
        ...valid,
        WF_OIDC_ENABLED: 'true',
        WF_OIDC_ISSUER: 'https://idp.example.internal',
        WF_OIDC_CLIENT_ID: 'wf',
        WF_OIDC_CLIENT_SECRET: 'secret',
        WF_OIDC_REDIRECT_URI: 'https://wf.example.internal/cb',
      }),
    ).toThrow(/WF_OIDC_ROLE_MAP/);
  });

  it('역할 맵은 JSON 객체여야 하고 값은 알려진 역할이어야 한다', () => {
    expect(parseEnv({ ...valid, WF_OIDC_ROLE_MAP: '{"a":"admin"}' }).WF_OIDC_ROLE_MAP).toEqual({ a: 'admin' });
    expect(() => parseEnv({ ...valid, WF_OIDC_ROLE_MAP: 'nope' })).toThrow(/WF_OIDC_ROLE_MAP/);
    expect(() => parseEnv({ ...valid, WF_OIDC_ROLE_MAP: '[1,2]' })).toThrow(/WF_OIDC_ROLE_MAP/);
    // 오타 난 역할이 "매핑 안 됨"으로 흘러가면 그 그룹이 이유 없이 로그인 거부된다
    expect(() => parseEnv({ ...valid, WF_OIDC_ROLE_MAP: '{"a":"adminn"}' })).toThrow(/WF_OIDC_ROLE_MAP/);
  });

  it('세션 타임아웃 기본값', () => {
    const env = parseEnv(valid);
    expect(env.WF_SESSION_IDLE_MINUTES).toBe(30);
    expect(env.WF_SESSION_ABSOLUTE_HOURS).toBe(12);
    expect(env.WF_ROOT_USERNAME).toBe('root');
  });
});

describe('.env.example ↔ 스키마 키 집합 (FR-015)', () => {
  it('키 집합이 정확히 같다', () => {
    const content = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
    const exampleKeys = extractEnvExampleKeys(content).sort();
    expect(exampleKeys).toEqual([...ENV_KEYS].sort());
  });

  it('extractEnvExampleKeys는 주석·빈 줄을 무시한다', () => {
    expect(extractEnvExampleKeys('# c\n\nA=1\n  B = 2 \n#D=4')).toEqual(['A', 'B']);
  });
});
