import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, EnvValidationError, extractEnvExampleKeys, parseDotenv, parseEnv } from './env';

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

describe('Phase 10 — LLM (P10_설계서_Llm I절)', () => {
  // 32바이트를 base64url(43자)과 base64(44자, `=` 하나)로 적은 것. **합성 값이다** — 모두 0인 바이트
  const url43 = 'A'.repeat(43);
  const std44 = `${'A'.repeat(43)}=`;

  it('마스터 키는 없어도 기동한다 — 비면 키 없는 LLM만 등록된다 (FR-1103)', () => {
    expect(parseEnv(valid).WF_LLM_MASTER_KEY).toBe('');
  });

  it('32바이트를 base64(url)로 적은 것만 받는다 — `openssl rand -base64 32`의 모양도', () => {
    expect(parseEnv({ ...valid, WF_LLM_MASTER_KEY: url43 }).WF_LLM_MASTER_KEY).toBe(url43);
    expect(parseEnv({ ...valid, WF_LLM_MASTER_KEY: std44 }).WF_LLM_MASTER_KEY).toBe(std44);
  });

  it('**모양이 틀리면 기동 실패** — 짧은 키로 암호화한 뒤에야 알면 되돌릴 수 없다', () => {
    expect(() => parseEnv({ ...valid, WF_LLM_MASTER_KEY: 'short' })).toThrow(/WF_LLM_MASTER_KEY/);
    expect(() => parseEnv({ ...valid, WF_LLM_MASTER_KEY: 'A'.repeat(44) })).toThrow(/WF_LLM_MASTER_KEY/);
    expect(() => parseEnv({ ...valid, WF_LLM_MASTER_KEY: `${'A'.repeat(42)}!` })).toThrow(/WF_LLM_MASTER_KEY/);
  });

  it('답 하나의 시간 상한은 기본 10분, 10초~1시간', () => {
    expect(parseEnv(valid).WF_LLM_TIMEOUT_MS).toBe(600_000);
    expect(parseEnv({ ...valid, WF_LLM_TIMEOUT_MS: '60000' }).WF_LLM_TIMEOUT_MS).toBe(60_000);
    expect(() => parseEnv({ ...valid, WF_LLM_TIMEOUT_MS: '5000' })).toThrow(/WF_LLM_TIMEOUT_MS/);
    expect(() => parseEnv({ ...valid, WF_LLM_TIMEOUT_MS: '3600001' })).toThrow(/WF_LLM_TIMEOUT_MS/);
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

/**
 * `parseDotenv`는 **테스트가 없었다** (P5 검증에서 발견).
 *
 * 하필 이 함수의 주석에 "앱·`check:env`·`dev:db`가 각자 파싱하고 있었고, 따옴표 처리를
 * 한 곳만 고쳤다가 `pnpm check:env`가 조용히 깨졌다"고 적혀 있다. 한 곳으로 모으는 것까지
 * 하고 **거기에 테스트를 두는 것을 안 했다** — 합계 커버리지가 90%를 넘겨 관문이 초록이었다.
 */
describe('parseDotenv', () => {
  it('키=값을 읽고 앞뒤 공백을 버린다', () => {
    expect(parseDotenv('A=1\n  B = 2  ')).toEqual({ A: '1', B: '2' });
  });

  it('주석과 빈 줄을 건너뛴다', () => {
    expect(parseDotenv('# 설명\n\nA=1\n#B=2')).toEqual({ A: '1' });
  });

  it('**따옴표를 벗긴다** — 홑·겹 둘 다. 짝이 맞을 때만', () => {
    expect(parseDotenv(`A="1"\nB='2'\nC="3\nD=4"`)).toEqual({ A: '1', B: '2', C: '"3', D: '4"' });
  });

  it('JSON 값이 홑따옴표로 감싸여 와도 안쪽은 그대로 남는다 — 셸에서 `source`하기 위한 규칙이다', () => {
    expect(parseDotenv(`WF_OIDC_ROLE_MAP='{"wf-users":"member"}'`)).toEqual({
      WF_OIDC_ROLE_MAP: '{"wf-users":"member"}',
    });
  });

  it('값에 `=`가 들어 있어도 **첫 `=`에서만** 자른다 — 비밀번호나 base64가 그렇다', () => {
    expect(parseDotenv('WF_SESSION_SECRET=a=b=c')).toEqual({ WF_SESSION_SECRET: 'a=b=c' });
  });

  it('`=`가 없는 줄과 `=`로 시작하는 줄은 버린다', () => {
    expect(parseDotenv('그냥글자\n=값만있다\nA=1')).toEqual({ A: '1' });
  });

  it('값이 비어 있어도 키는 남는다 — "비워 뒀다"와 "안 적었다"는 다르다', () => {
    expect(parseDotenv('A=\nB=1')).toEqual({ A: '', B: '1' });
  });

  it('줄바꿈이 CRLF여도 같게 읽는다', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});
