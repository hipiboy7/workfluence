import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, EnvValidationError, extractEnvExampleKeys, parseEnv } from './env';

const valid = { WF_DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/db' };

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
    // Phase 1에서 도입할 키도 지금은 선언되어 있지 않으므로 거부된다
    expect(() => parseEnv({ ...valid, WF_SESSION_SECRET: 'x'.repeat(32) })).toThrow(/WF_SESSION_SECRET/);
  });

  it('타입·범위가 틀리면 기동 실패', () => {
    expect(() => parseEnv({ ...valid, WF_PORT: 'abc' })).toThrow(/WF_PORT/);
    expect(() => parseEnv({ ...valid, WF_PORT: '70000' })).toThrow(/WF_PORT/);
    expect(() => parseEnv({ ...valid, WF_PG_EMBEDDED_PORT: '80' })).toThrow(/WF_PG_EMBEDDED_PORT/);
    expect(() => parseEnv({ ...valid, WF_TRUST_PROXY: 'yes' })).toThrow(/WF_TRUST_PROXY/);
    expect(() => parseEnv({ ...valid, WF_DATABASE_URL: 'not-a-url' })).toThrow(/WF_DATABASE_URL/);
    expect(() => parseEnv({})).toThrow(/WF_DATABASE_URL/);
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
