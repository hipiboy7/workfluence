import { Global, Module } from '@nestjs/common';
import { parseDotenv, parseEnv, type AppEnv } from '@workfluence/shared';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const APP_ENV = Symbol('APP_ENV');
export type AppEnvToken = AppEnv;

/** 저장소 루트의 .env를 읽는다. process.env가 우선한다. 운영 컨테이너는 .env 마운트 또는 환경변수 주입. */
export function loadEnv(): AppEnv {
  const candidates = [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../../.env')];
  const found = candidates.find((p) => existsSync(p));
  // 파싱은 shared의 parseDotenv 한 곳에서 한다 (CLAUDE.md 1.3절)
  const fromFile = found ? parseDotenv(readFileSync(found, 'utf8')) : {};
  return parseEnv({ ...fromFile, ...process.env });
}

/**
 * 실행 환경에 맞는 DB 접속 문자열. **연결하는 모든 경로(앱·마이그레이션·시드·스키마 생성)가 이 함수를 쓴다.**
 *
 * `WF_ENV=test`인데 테스트 URL이 없으면 **개발 DB로 조용히 붙지 않고 실패한다.**
 * 통합 테스트가 개발 데이터를 지우는 사고를 막는다.
 */
export function databaseUrl(env: AppEnv): string {
  if (env.WF_ENV !== 'test') return env.WF_DATABASE_URL;
  if (!env.WF_DATABASE_URL_TEST) {
    throw new Error('WF_ENV=test인데 WF_DATABASE_URL_TEST가 없다. 개발 DB로 대체하지 않는다 — .env에 테스트 DB를 지정한다.');
  }
  return env.WF_DATABASE_URL_TEST;
}

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: loadEnv }],
  exports: [APP_ENV],
})
export class ConfigModule {}
