import { defineConfig } from 'drizzle-kit';
import { databaseUrl, loadEnv } from './src/config/config.module';

/**
 * 마이그레이션 SQL 생성 전용. 적용은 src/db/migrate.ts (CLAUDE.md 6절: 운영은 명시적 단계로만).
 *
 * 접속 문자열을 리터럴로 두지 않는다 (CLAUDE.md 5절 하드코딩 금지). `.env`를 읽는 로더와
 * 접속 문자열 선택을 앱과 **똑같이** 쓴다 — 다르면 스키마를 생성한 DB와 앱이 붙는 DB가 갈린다.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: databaseUrl(loadEnv()) },
  strict: true,
  verbose: true,
});
